import * as React from "react"
import { cn } from "cn"

/**
 * The G from the GG Entertainment logo, traced from `design/brand/logo-dark.png`
 * so it stays crisp at 24px and inherits its colour from the page.
 *
 * On the paper canvas a volt G on its own is 1.3:1, so by default the mark
 * carries a thin ink outline drawn beneath the fill (`paint-order: stroke`),
 * the way the site's thick ink borders anchor its yellow. The stroke is the
 * constant ink token, so on an ink surface (night mode, the Guild card back)
 * it merges with the background and the G reads as plain volt there.
 */
function GMark({
  className,
  title = "GG Entertainment",
  outline = true,
  ...props
}: React.ComponentProps<"svg"> & { title?: string; outline?: boolean }) {
  return (
    <svg
      data-slot="g-mark"
      viewBox="0 0 100 53.08"
      role="img"
      aria-label={title}
      className={cn("h-6 w-auto text-volt", className)}
      {...props}
    >
      <path
        fill="currentColor"
        stroke={outline ? "var(--gg-ink)" : "none"}
        strokeWidth={outline ? 6 : 0}
        strokeLinejoin="round"
        paintOrder="stroke"
        d="M34.76 0L100 0.17L86.13 15.41L40.24 15.41L39.21 15.75L37.16 17.64L27.05 36.3L27.05 38.53L27.91 39.73L28.94 40.24L58.22 40.41L62.33 33.05L42.98 33.05L49.66 23.12L92.98 23.12L93.15 23.46L75.17 53.08L9.76 53.08L5.48 52.05L3.25 50.68L1.71 49.14L0.51 47.09L0 44.86L0.51 41.27L16.1 11.3L18.15 8.56L23.46 3.94L28.94 1.2Z"
      />
    </svg>
  )
}

type WordmarkProps = React.ComponentProps<"span"> & {
  /** Puts the volt G mark in front of the letters. */
  mark?: boolean
  /** The product name. Change it here once if the working name changes. */
  name?: string
}

/** "GG VAULT" in Space Mono 700, tracked .28em, 13px. Top left of every screen. */
function Wordmark({
  className,
  mark = false,
  name = "GG Vault",
  ...props
}: WordmarkProps) {
  return (
    <span
      data-slot="wordmark"
      className={cn("inline-flex items-center gap-2.5 text-foreground", className)}
      {...props}
    >
      {mark ? <GMark className="h-[1.125rem]" /> : null}
      <span className="font-mono text-[13px] leading-none font-bold tracking-[0.28em] uppercase">
        {name}
      </span>
    </span>
  )
}

export { Wordmark, GMark }
export type { WordmarkProps }
