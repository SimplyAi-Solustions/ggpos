/**
 * The customer-facing screen: a tablet on the counter, turned to face the
 * shop, signed in as staff and left there.
 *
 * It reads one row, `display_state`, over realtime and renders whatever the
 * counter last published. There is no navigation on it, nothing to type
 * into, and one action in its whole life: the customer accepting a buy-in
 * offer, which is the screen's single block button. Everything else is read
 * across a counter from a metre away, so the figures are large and the
 * supporting text is not.
 *
 * Idle is the shop's own page: the logo lockup, the ticker from Settings as
 * the marketing site's volt band, and the sign-up QR.
 */
import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { formatGBP } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { MicroLabel } from "@/components/ui/micro-label"
import { PageTitle } from "@/components/ui/page-title"
import { Seal } from "@/components/ui/seal"
import { GGLogo } from "@/components/ui/wordmark"
import { ProductImage } from "@/components/product-image"
import { QrCode } from "@/features/customers/GuildCard"
import { Ticker } from "@/features/display/Ticker"
import { useCounterConfig } from "@/lib/api/config"
import { acceptDisplay, subscribeDisplay } from "@/lib/api/display"
import { refusalOrFallback } from "@/lib/api/refusal"
import type {
  DisplayBuyInPayload,
  DisplayMode,
  DisplaySalePayload,
  DisplayState,
} from "@/lib/api/types"

const IDLE_STATE: DisplayState = {
  mode: "idle",
  payload: {},
  token: "",
  customer_accepted_at: "",
  expires_at: "",
}

/** What the offer will be paid as, in the words the customer will hear. */
const PAYOUT_WORD: Record<string, string> = {
  cash: "cash",
  credit: "store credit",
  mixed: "part cash and part store credit",
}

/**
 * Keeps the tablet awake while this screen is open.
 *
 * The Screen Wake Lock API is not everywhere, and a browser drops the lock
 * whenever the page is hidden, so the sentinel is asked for again when the
 * tab comes back. Where it is missing the tablet's own display timeout
 * stands: nothing here depends on it.
 */
function useWakeLock() {
  React.useEffect(() => {
    let sentinel: WakeLockSentinel | null = null
    let live = true

    async function hold() {
      if (!("wakeLock" in navigator)) return
      try {
        sentinel = await navigator.wakeLock.request("screen")
      } catch {
        // Denied, or the tablet is on battery saver. The screen still works.
      }
    }

    function onVisible() {
      if (document.visibilityState === "visible" && live) void hold()
    }

    void hold()
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      live = false
      document.removeEventListener("visibilitychange", onVisible)
      void sentinel?.release().catch(() => {})
    }
  }, [])
}

/** The absolute address a phone's camera can open, from a stored path. */
function signupLink(url: string): string {
  if (typeof window === "undefined") return url
  try {
    return new URL(url, window.location.origin).toString()
  } catch {
    return window.location.origin
  }
}

function Line({
  title,
  detail,
  qty,
  amount,
  image,
}: {
  title: string
  detail: string
  qty: number
  amount: number
  image?: string
}) {
  return (
    <li className="flex items-center gap-5 border-b border-hairline-soft py-4 first:border-t">
      {/*
        The payload carries a picture but never what the thing is, so the
        frame cannot be the platform's own ratio: a square frame with the
        cut-out finish contains a card, a box or a console without cropping
        any of them and without drawing a printed edge around a photograph.
      */}
      <ProductImage
        src={image || null}
        alt=""
        ratio={[1, 1]}
        finish="shadow"
        height={56}
        className="shrink-0"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[18px] leading-[1.35] text-foreground sm:text-[20px]">
          {title}
        </span>
        {detail ? (
          <span className="block truncate text-[14px] leading-[1.4] text-muted-foreground">
            {detail}
          </span>
        ) : null}
      </span>
      {qty > 1 ? (
        <span className="tnum shrink-0 font-mono text-[13px] text-muted-foreground-2">
          x{qty}
        </span>
      ) : null}
      <span className="tnum shrink-0 text-[18px] leading-none font-medium text-foreground sm:text-[20px]">
        {formatGBP(amount * qty)}
      </span>
    </li>
  )
}

/** The one big figure on the screen, in the display face. */
function Total({
  label,
  amount,
  testId,
}: {
  label: string
  amount: number
  testId: string
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
      <MicroLabel tone="ink">{label}</MicroLabel>
      <span
        data-testid={testId}
        className="tnum font-display text-[44px] leading-none tracking-[0.01em] text-foreground sm:text-[56px]"
      >
        {formatGBP(amount)}
      </span>
    </div>
  )
}

function Header({ name }: { name?: string }) {
  return (
    <header className="flex items-center justify-between gap-6">
      <GGLogo className="h-8 w-auto sm:h-10" />
      {name ? (
        <span
          data-testid="display-customer"
          className="truncate text-[16px] text-muted-foreground sm:text-[18px]"
        >
          {name}
        </span>
      ) : null}
    </header>
  )
}

function IdleScreen({ ticker, signupUrl }: { ticker: string; signupUrl: string }) {
  return (
    <div data-testid="display-idle" className="flex min-h-dvh flex-col">
      <div className="flex flex-1 flex-col items-center justify-center px-5 py-14 text-center sm:px-10">
        <GGLogo className="h-20 w-auto sm:h-28" />
        <PageTitle className="mt-10">Join GG Guild</PageTitle>
        {/* A QR is dark modules on a light field with a quiet zone around
            them, or a camera will not read it: in night mode that field has
            to be drawn rather than inherited from the canvas. */}
        <div className="mt-12 rounded-[var(--radius)] bg-gg-paper p-4">
          <QrCode
            text={signupLink(signupUrl)}
            title="Join GG Guild"
            className="size-48 sm:size-60"
          />
        </div>
        <p className="mt-7 max-w-[44ch] text-[18px] leading-[1.45] text-foreground sm:text-[20px]">
          Scan it, or join at the counter
        </p>
        <p className="mt-3 max-w-[48ch] text-[15px] leading-[1.5] text-muted-foreground">
          Points on what you buy, a better rate on what you trade in, and your
          card on your phone.
        </p>
      </div>
      <Ticker text={ticker} />
    </div>
  )
}

function SaleScreen({ payload }: { payload: DisplaySalePayload }) {
  return (
    <div
      data-testid="display-sale"
      className="mx-auto flex min-h-dvh w-full max-w-[1040px] flex-col justify-center px-5 py-10 sm:px-10"
    >
      <Header name={payload.customer_name} />
      <PageTitle className="mt-8">Your basket</PageTitle>

      <ul className="mt-10">
        {payload.lines.map((line, index) => (
          <Line
            key={`${line.title}-${index}`}
            title={line.title}
            detail={line.detail}
            qty={line.qty}
            amount={line.unit_price}
            image={line.image_url}
          />
        ))}
      </ul>

      {payload.discount > 0 ? (
        <div className="flex items-baseline justify-between gap-6 border-b border-hairline-soft py-4">
          <span className="text-[16px] text-muted-foreground sm:text-[18px]">
            {payload.discount_label || "Discount"}
          </span>
          <span
            data-testid="display-discount"
            className="tnum text-[18px] leading-none font-medium text-foreground sm:text-[20px]"
          >
            -{formatGBP(payload.discount)}
          </span>
        </div>
      ) : null}

      <div className="mt-10">
        <Total label="Total" amount={payload.total} testId="display-total" />
        {payload.points_to_earn > 0 ? (
          <p
            data-testid="display-points"
            className="mt-4 text-[16px] text-muted-foreground sm:text-[18px]"
          >
            Earns {payload.points_to_earn.toLocaleString("en-GB")} points
          </p>
        ) : null}
      </div>
    </div>
  )
}

function BuyInScreen({
  payload,
  accepted,
  accepting,
  error,
  onAccept,
}: {
  payload: DisplayBuyInPayload
  accepted: boolean
  accepting: boolean
  error: string | null
  onAccept: () => void
}) {
  return (
    <div
      data-testid="display-buyin"
      className="mx-auto flex min-h-dvh w-full max-w-[1040px] flex-col justify-center px-5 py-10 sm:px-10"
    >
      <Header name={payload.customer_name} />

      {accepted ? (
        <div data-testid="display-accepted" className="mt-14">
          <Seal tick />
          <PageTitle className="mt-10">Accepted</PageTitle>
          <p className="mt-6 max-w-[40ch] text-[18px] leading-[1.45] text-foreground sm:text-[20px]">
            Thanks, now sign at the counter.
          </p>
        </div>
      ) : (
        <>
          <PageTitle className="mt-8">Our offer</PageTitle>

          <ul className="mt-10">
            {payload.lines.map((line, index) => (
              <Line
                key={`${line.title}-${index}`}
                title={line.title}
                detail={line.detail}
                qty={line.qty}
                amount={line.offer_price}
                image={line.image_url}
              />
            ))}
          </ul>

          <div className="mt-10 flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
            <span className="text-[16px] text-muted-foreground sm:text-[18px]">
              What these sell for here
            </span>
            <span className="tnum text-[18px] leading-none font-medium text-muted-foreground sm:text-[20px]">
              {formatGBP(payload.total_market)}
            </span>
          </div>

          <div className="mt-6">
            <Total label="Our offer" amount={payload.total_offer} testId="display-offer" />
            <p className="mt-4 text-[16px] text-muted-foreground sm:text-[18px]">
              Paid in {PAYOUT_WORD[payload.payout_type] ?? "store credit"}
              {payload.credit_bonus_points
                ? `, and it earns ${payload.credit_bonus_points.toLocaleString("en-GB")} points`
                : ""}
              .
            </p>
          </div>

          <div className="mt-12">
            <Button
              data-testid="display-accept"
              className="h-[72px] w-full text-[13px]"
              loading={accepting}
              onClick={onAccept}
            >
              Accept
            </Button>
            <p className="mt-5 max-w-[48ch] text-[15px] leading-[1.5] text-muted-foreground">
              Accepting shows the counter you are happy with the offer. You
              sign for it there.
            </p>
            {error ? (
              <p role="alert" className="mt-5 text-[15px] text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * The kiosk itself: one subscription, one wake lock, and whichever of the
 * three screens the counter has published.
 */
export function DisplayScreen() {
  const [state, setState] = React.useState<DisplayState>(IDLE_STATE)
  const [error, setError] = React.useState<string | null>(null)
  const { data: config } = useCounterConfig()
  const token = state.token

  useWakeLock()

  React.useEffect(() => subscribeDisplay(setState), [])

  // A publish nobody cleared goes back to the shop's own screen rather than
  // leaving somebody's basket up while the shop is shut. The timer marks
  // the token that ran out, so the next publish, which carries a new token,
  // is live again without anything to reset.
  const [ranOut, setRanOut] = React.useState("")
  const expiresAt = state.expires_at ? new Date(state.expires_at).getTime() : 0
  const deadline = Number.isNaN(expiresAt) ? 0 : expiresAt

  React.useEffect(() => {
    if (!deadline || !token) return undefined
    const timer = window.setTimeout(
      () => setRanOut(token),
      Math.max(0, deadline - Date.now())
    )
    return () => window.clearTimeout(timer)
  }, [deadline, token])

  const accept = useMutation({
    mutationFn: () => acceptDisplay(token),
    onMutate: () => setError(null),
    onError: (problem) =>
      setError(
        refusalOrFallback(
          problem,
          "That did not go through. Ask at the counter to send the offer again."
        )
      ),
  })

  const mode: DisplayMode = token && token === ranOut ? "idle" : state.mode

  if (mode === "sale") {
    return <SaleScreen payload={state.payload as DisplaySalePayload} />
  }

  if (mode === "buy_in") {
    return (
      <BuyInScreen
        payload={state.payload as DisplayBuyInPayload}
        accepted={Boolean(state.customer_accepted_at)}
        accepting={accept.isPending}
        error={error}
        onAccept={() => accept.mutate()}
      />
    )
  }

  return (
    <IdleScreen
      ticker={config?.display.ticker ?? "Game · Trade · Play"}
      signupUrl={config?.display.signup_url ?? "/estimate"}
    />
  )
}
