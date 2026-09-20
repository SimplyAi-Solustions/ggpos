import * as React from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { formatGBP } from "@gg/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { MicroLabel } from "@/components/ui/micro-label"
import { PageTitle } from "@/components/ui/page-title"
import { SkeletonText } from "@/components/ui/skeleton"
import { StickerRing } from "@/components/ui/sticker"
import { GuildCardFront } from "@/features/customers/GuildCard"
import { getMe } from "@/lib/api/portal"

/**
 * My card: the thing a customer opens at the counter.
 *
 * The playing-card front is the counter's own component at wallet size, so
 * the card on the phone and the card out of the printer are one design. It is
 * scaled to the column rather than redrawn, and everything it needs is in the
 * one `/me` read: no clock, no countdown, nothing that changes while it is on
 * screen, because this has to work as a screenshot on a dead phone.
 */

/** The wallet card is 85.6mm wide; CSS millimetres are 96/25.4 px. */
const CARD_WIDTH_PX = 85.6 * (96 / 25.4)
const CARD_HEIGHT_PX = 53.98 * (96 / 25.4)

function ScaledCard({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [scale, setScale] = React.useState(1)

  React.useLayoutEffect(() => {
    const node = ref.current
    if (!node) return undefined
    const measure = () => {
      // Never below 1:1 on a phone, and never so large on a desk that the
      // card stops reading as a card.
      setScale(Math.min(1.45, node.clientWidth / CARD_WIDTH_PX))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={ref} className="w-full" style={{ height: CARD_HEIGHT_PX * scale }}>
      <div
        className="origin-top-left"
        style={{ transform: `scale(${scale})`, width: CARD_WIDTH_PX }}
      >
        {children}
      </div>
    </div>
  )
}

/** The browser's own install prompt, offered once, never nagged. */
type InstallEvent = Event & { prompt: () => Promise<void> }

function useInstallPrompt() {
  const [event, setEvent] = React.useState<InstallEvent | null>(null)

  React.useEffect(() => {
    const onPrompt = (raw: Event) => {
      raw.preventDefault()
      setEvent(raw as InstallEvent)
    }
    window.addEventListener("beforeinstallprompt", onPrompt)
    return () => window.removeEventListener("beforeinstallprompt", onPrompt)
  }, [])

  return {
    available: event !== null,
    show: async () => {
      if (!event) return
      await event.prompt()
      setEvent(null)
    },
  }
}

function Figure({
  label,
  value,
  testId,
}: {
  label: string
  value: string
  testId?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <MicroLabel>{label}</MicroLabel>
      <span data-testid={testId} className="tnum text-[20px] leading-none font-medium">
        {value}
      </span>
    </div>
  )
}

export function CardScreen() {
  const install = useInstallPrompt()
  const { data: me, isPending } = useQuery({
    queryKey: ["portal", "me"],
    queryFn: getMe,
  })

  if (isPending) {
    return (
      <section className="pt-12 sm:pt-20">
        <SkeletonText lines={5} />
      </section>
    )
  }

  if (!me) {
    return (
      <section className="pt-12 sm:pt-20">
        <PageTitle>My card</PageTitle>
        <p className="mt-4 max-w-[56ch] text-base leading-[1.5] text-muted-foreground">
          We could not read your card just now. Check your connection and
          reload the page.
        </p>
      </section>
    )
  }

  const tier = me.tier?.name ?? "Member"

  return (
    <section className="pt-12 sm:pt-20">
      <PageTitle>My card</PageTitle>
      <p className="mt-3 max-w-[56ch] text-base leading-[1.5] text-muted-foreground">
        Show this at the counter. It works from a screenshot.
      </p>

      <div className="mt-10">
        <ScaledCard>
          <GuildCardFront
            name={me.customer.name}
            code={me.customer.code}
            qrToken={me.customer.qr_token}
            tier={tier}
            size="wallet"
          />
        </ScaledCard>
      </div>

      {/* The card already prints the name and the code; the badge is the
          one thing on this screen that has to be readable across a counter. */}
      <div className="mt-10">
        <Badge variant="volt">{tier}</Badge>
      </div>

      <div className="mt-12 grid grid-cols-2 gap-x-6 gap-y-8">
        <Figure
          label="Points"
          value={me.balances.points.toLocaleString("en-GB")}
          testId="portal-points"
        />
        <Figure
          label="Store credit"
          value={formatGBP(me.balances.credit)}
          testId="portal-credit"
        />
      </div>

      {install.available ? (
        <div className="mt-14 flex items-start gap-5">
          <StickerRing className="size-12" />
          <div className="flex flex-col items-start gap-2">
            <p className="text-[15px] leading-[1.5] text-muted-foreground">
              Add My Vault to your home screen and your card is one tap away.
            </p>
            <Button variant="text" type="button" onClick={() => void install.show()}>
              Add to home screen
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-14 flex flex-col items-start gap-8">
        <Button variant="text" render={<Link to="/account/trade-ins" />}>
          My trade-ins
        </Button>
        <Button variant="text" render={<Link to="/account/estimate" />}>
          Get an estimate
        </Button>
      </div>
    </section>
  )
}
