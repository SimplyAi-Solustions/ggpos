import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { formatGBP } from "@gg/shared"

import { PageTitle, Lede } from "@/components/ui/page-title"
import { LoadFailed } from "@/features/portal/LoadFailed"
import { getWallet, getWalletToken, type WalletBalance } from "@/features/portal/wallet"
import { isDemo } from "@/lib/api/mode"
import { getMe } from "@/lib/api/portal"
import "@/features/binders/binders.css"

/** The demo has no till mirror; it shows the demo customer's credit as-is. */
async function demoWallet(): Promise<WalletBalance> {
  const me = await getMe()
  return {
    balance_minor: me.balances.credit,
    balance_at: new Date().toISOString(),
    stale: false,
  }
}

/**
 * The wallet: store credit at GG Entertainment. The till (Epos Now) owns the
 * balance; what shows here is a mirror that the shop updates, so the screen
 * never computes anything. The QR is a signed two-minute token minted every
 * sixty seconds; a screenshot goes stale before it leaves the car park.
 */

function QR({ text }: { text: string }) {
  const [markup, setMarkup] = React.useState<string | null>(null)
  React.useEffect(() => {
    let cancelled = false
    void import("bwip-js/browser")
      .then(({ toSVG }) => {
        if (cancelled) return
        setMarkup(toSVG({ bcid: "qrcode", text, scale: 3, padding: 0 }))
      })
      .catch(() => {
        if (!cancelled) setMarkup(null)
      })
    return () => {
      cancelled = true
    }
  }, [text])
  if (!markup) return <div className="gg-wallet-qr" role="img" aria-label="Your wallet code is loading" />
  return (
    <div
      className="gg-wallet-qr"
      role="img"
      aria-label="Your wallet code. Show this at the counter."
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  )
}

function updatedLine(iso: string): string {
  const at = new Date(iso.replace(" ", "T"))
  if (Number.isNaN(at.getTime())) return ""
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  const sameDay = at.toDateString() === new Date().toDateString()
  return sameDay
    ? `Updated ${time}`
    : `Updated ${at.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${time}`
}

export function WalletScreen() {
  const demo = isDemo()
  const wallet = useQuery({
    queryKey: ["portal", "wallet"],
    queryFn: demo ? demoWallet : getWallet,
    // The demo balance follows redemptions, so it is always re-read.
    staleTime: demo ? 0 : 60_000,
  })
  // A fresh token every minute while the page is visible; each one lives
  // for two, so the code on screen is never within a minute of dying.
  const tokenQ = useQuery({
    queryKey: ["portal", "wallet-token"],
    queryFn: demo ? async () => ({ token: "GGW1.DEMO", ttl: 120 }) : getWalletToken,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: 0,
    gcTime: 0,
  })

  if (wallet.isError) {
    return (
      <LoadFailed
        title="Wallet"
        error={wallet.error}
        fallback="Your wallet did not load. Check your connection and try again."
        onRetry={() => void wallet.refetch()}
      />
    )
  }

  const data = wallet.data
  const hasBalance = !!data && data.balance_minor !== null && !data.stale

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Wallet</PageTitle>
      <Lede>Your store credit lives at the till. Show the code at the counter to use it.</Lede>

      <div className="gg-card gg-wallet mt-10" style={{ "--accent": "var(--volt)" } as React.CSSProperties}>
        <p className="gg-kicker">GG store credit</p>
        {wallet.isPending ? (
          <div className="bx-skel mt-4" style={{ height: 44, width: 180 }} />
        ) : hasBalance ? (
          <>
            <p className="gg-wallet-balance tnum" data-testid="credit-balance">
              {formatGBP(data.balance_minor as number)}
            </p>
            <p className="gg-wallet-updated">{updatedLine(data.balance_at)}</p>
          </>
        ) : (
          <p className="gg-wallet-ask">Ask at the counter for your latest balance.</p>
        )}
        {tokenQ.data ? (
          <QR text={tokenQ.data.token} />
        ) : (
          <div className="gg-wallet-qr" aria-hidden="true" />
        )}
        <p className="gg-wallet-note">The code refreshes itself every minute.</p>
      </div>

      <p className="mt-8 max-w-[46ch] text-[14px] leading-[1.55] text-muted-foreground-2">
        Credit is added and spent at the counter. The balance shown here follows the till and can run
        a little behind it.
      </p>
    </section>
  )
}
