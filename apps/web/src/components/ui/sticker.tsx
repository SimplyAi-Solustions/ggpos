import * as React from "react"
import { cn } from "cn"

/**
 * The marketing site's doodles, redrawn as inline SVG at a 4px stroke.
 * They appear in empty states and on the customer card, and nowhere else.
 */

const VOLT = "#fedf01"
const POP = "#ff2e6b"
const INK = "#0b0b0b"

type StickerProps = React.ComponentProps<"svg">

function baseProps(className?: string) {
  return {
    viewBox: "0 0 64 64",
    fill: "none" as const,
    "aria-hidden": true,
    focusable: "false" as const,
    className: cn("size-16 shrink-0", className),
  }
}

/** Yellow ring with a pink centre. */
function StickerRing({ className, ...props }: StickerProps) {
  return (
    <svg data-slot="sticker" data-sticker="ring" {...baseProps(className)} {...props}>
      <circle cx="32" cy="32" r="24" stroke={VOLT} strokeWidth="4" />
      <circle cx="32" cy="32" r="8" fill={POP} />
    </svg>
  )
}

/** Pink circle with a tilted ellipse across it. */
function StickerOrbit({ className, ...props }: StickerProps) {
  return (
    <svg data-slot="sticker" data-sticker="orbit" {...baseProps(className)} {...props}>
      <circle cx="32" cy="32" r="20" stroke={POP} strokeWidth="4" />
      <ellipse
        cx="32"
        cy="32"
        rx="29"
        ry="11"
        stroke={INK}
        strokeWidth="4"
        transform="rotate(-24 32 32)"
      />
    </svg>
  )
}

/** A tilted pair of cards, one volt, one paper. */
function StickerCards({ className, ...props }: StickerProps) {
  return (
    <svg data-slot="sticker" data-sticker="cards" {...baseProps(className)} {...props}>
      <rect
        x="12"
        y="14"
        width="28"
        height="38"
        rx="3"
        fill={VOLT}
        stroke={INK}
        strokeWidth="4"
        transform="rotate(-12 26 33)"
      />
      <rect
        x="26"
        y="12"
        width="28"
        height="38"
        rx="3"
        stroke={INK}
        strokeWidth="4"
        transform="rotate(9 40 31)"
      />
    </svg>
  )
}

export { StickerRing, StickerOrbit, StickerCards }
export type { StickerProps }
