import * as React from "react"
import { displayCode } from "@gg/shared"
import { cn } from "cn"

import { GMark } from "@/components/ui/wordmark"
import { portalLink } from "@/features/customers/format"

/**
 * The GG Guild card, in the playing-card format the marketing site uses: a
 * landscape rectangle with a hairline edge, the QR on the left, the name and
 * code on the right, the wordmark small in a corner, and a pinstripe back.
 *
 * Two sizes, both real: the 80 x 50 mm die-cut label the ORGSTA T003 prints
 * (docs/label-spec.md) and a wallet card at ID-1, 85.6 x 53.98 mm, for the
 * customer who wants a PDF instead. Both are laid out in millimetres so what
 * is on screen is what comes out of the printer.
 */

export type GuildCardSize = "label" | "wallet"

const SIZES: Record<GuildCardSize, { width: number; height: number; qr: number }> = {
  // 80 x 50 mm at 203 dpi is 640 x 400 px; the QR is about 260 px, which is
  // 32.5 mm. See docs/label-spec.md.
  label: { width: 80, height: 50, qr: 32.5 },
  wallet: { width: 85.6, height: 53.98, qr: 34 },
}

/**
 * The QR as an inline SVG, so it stays sharp at 203 dpi and in a PDF.
 *
 * bwip-js is one 900 kB module that cannot be split further, so it is
 * imported dynamically rather than at the top of this file: the card's own
 * text, name, code and tier paint on the first frame and the QR fills in
 * when the module lands. That matters most on My Vault, where the card is
 * the whole screen and the customer is standing at the counter on a phone;
 * it costs the counter's card and label pages nothing, because both render
 * the same placeholder for one frame and then the same SVG.
 */
export function QrCode({
  text,
  className,
  style,
  title,
}: {
  text: string
  className?: string
  style?: React.CSSProperties
  title: string
}) {
  const [markup, setMarkup] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void import("bwip-js/browser")
      .then(({ toSVG }) => {
        if (cancelled) return
        // Scale 3 keeps the module grid sharp when the SVG is scaled to the
        // millimetre box; error correction stays at BWIPP's default M.
        setMarkup(toSVG({ bcid: "qrcode", text, scale: 3, padding: 0 }))
      })
      .catch(() => {
        if (!cancelled) setMarkup(null)
      })
    return () => {
      cancelled = true
    }
  }, [text])

  if (!markup) {
    // The frame the QR will fill, at the size it will be, so nothing on the
    // card moves when it arrives.
    return (
      <div
        role="img"
        aria-label={title}
        style={style}
        className={cn("border border-hairline", className)}
      />
    )
  }

  return (
    <div
      role="img"
      aria-label={title}
      style={style}
      // bwip-js returns a complete <svg> with its own viewBox; the wrapper
      // sets the size and these two rules make it fill the wrapper exactly.
      className={cn("[&>svg]:h-full [&>svg]:w-full", className)}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  )
}

export interface GuildCardProps {
  name: string
  code: string
  qrToken: string | undefined
  tier?: string
  size?: GuildCardSize
  className?: string
}

/** The front of the card. */
export function GuildCardFront({
  name,
  code,
  qrToken,
  tier = "Member",
  size = "label",
  className,
}: GuildCardProps) {
  const spec = SIZES[size]
  return (
    <div
      data-testid="guild-card-front"
      style={{ width: `${spec.width}mm`, height: `${spec.height}mm` }}
      className={cn(
        "relative flex items-center gap-[4mm] overflow-hidden border border-hairline bg-background px-[4mm] py-[3.5mm]",
        className
      )}
    >
      <QrCode
        text={portalLink(qrToken)}
        title={`Guild card QR for ${name}`}
        className="shrink-0"
        // Millimetres, so the printed square is the size the spec asks for.
        style={{ width: `${spec.qr}mm`, height: `${spec.qr}mm` }}
      />
      <div className="flex min-w-0 flex-1 flex-col justify-between self-stretch">
        <div className="min-w-0">
          <span className="block font-mono text-[6pt] leading-none font-bold tracking-[0.28em] text-muted-foreground uppercase">
            GG Guild
          </span>
          <span className="mt-[2mm] block truncate text-[12pt] leading-[1.15] text-foreground">
            {name}
          </span>
          <span className="tnum mt-[1.5mm] block font-mono text-[9pt] leading-none text-foreground">
            {displayCode(code)}
          </span>
        </div>
        <div className="flex items-end justify-between gap-3">
          <span className="font-mono text-[6pt] leading-none font-bold tracking-[0.16em] text-muted-foreground uppercase">
            {tier}
          </span>
          <GMark className="h-[3.5mm]" title="GG Entertainment" />
        </div>
      </div>
    </div>
  )
}

/** The back: the site's pinstripe, the wordmark, and nothing else. */
export function GuildCardBack({
  size = "label",
  className,
}: {
  size?: GuildCardSize
  className?: string
}) {
  const spec = SIZES[size]
  return (
    <div
      data-testid="guild-card-back"
      style={{ width: `${spec.width}mm`, height: `${spec.height}mm` }}
      className={cn(
        "relative flex items-center justify-center overflow-hidden border border-hairline bg-background",
        className
      )}
    >
      {/* A drawn texture rather than a repeating gradient: it prints
          crisply at 203 dpi and follows the ink colour in night mode. */}
      <svg
        aria-hidden="true"
        className="absolute inset-0 size-full text-hairline"
        preserveAspectRatio="none"
        viewBox="0 0 80 50"
      >
        <defs>
          <pattern
            id="gg-pinstripe"
            width="4"
            height="4"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="4" stroke="currentColor" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="80" height="50" fill="url(#gg-pinstripe)" />
      </svg>
      <span className="relative flex items-center gap-[2mm] bg-background px-[3mm] py-[1.5mm]">
        <GMark className="h-[4mm]" title="GG Entertainment" />
        <span className="font-mono text-[7pt] leading-none font-bold tracking-[0.28em] text-foreground uppercase">
          GG Guild
        </span>
      </span>
    </div>
  )
}
