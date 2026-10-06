import * as React from "react"
import { cn } from "cn"

/**
 * A Code 128 barcode as an inline SVG, for the Epos Now till's scanner.
 *
 * The till reads a customer by the card number on their Epos Now record,
 * which is their bare GGC code, so this encodes exactly that and nothing
 * else. It is drawn by bwip-js, the barcode library the app already ships
 * for every QR code, loaded lazily the same way `QrCode` loads it: the code
 * paints as text on the first frame and the bars fill in when the module
 * lands, in a frame already the size they will take, so nothing moves.
 *
 * Ink bars on the paper canvas only. A barcode needs the contrast and the
 * quiet zone either side (ten modules, `paddingwidth`), so it never sits on
 * a tint and is never drawn in volt.
 */
export function Code128({
  text,
  title,
  className,
  style,
}: {
  text: string
  title: string
  className?: string
  style?: React.CSSProperties
}) {
  const [markup, setMarkup] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void import("bwip-js/browser")
      .then(({ toSVG }) => {
        if (cancelled) return
        setMarkup(
          toSVG({
            bcid: "code128",
            text,
            scale: 3,
            height: 14,
            includetext: false,
            paddingwidth: 10,
            paddingheight: 0,
          })
        )
      })
      .catch(() => {
        if (!cancelled) setMarkup(null)
      })
    return () => {
      cancelled = true
    }
  }, [text])

  if (!markup) {
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
      className={cn("bg-white [&>svg]:h-full [&>svg]:w-full", className)}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  )
}
