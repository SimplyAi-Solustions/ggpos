import * as React from "react"
import { cn } from "cn"

import { G, LOGO } from "@/design/brand/logo-paths"

/**
 * The GG Entertainment logo: a paper G and a volt G, each with the logo's
 * thick ink outline, traced from `design/brand/logo.png` by
 * `scripts/trace-logo.mjs` so it stays crisp at 18px.
 *
 * The outline is what makes the mark work on paper: a white G without it is
 * invisible and a volt G alone is 1.3:1. It is drawn as a stroke beneath the
 * fill (`paint-order: stroke`) in the constant ink token, so on an ink
 * surface (night mode, the app icon) it merges with the background and the
 * lockup reads as the site's logo-dark, white G and volt G, with nothing to
 * switch. `mono` fills both Gs with the text colour and drops the outline,
 * for thermal labels and anything else that prints in one colour.
 */
function GGLogo({
  className,
  title = "GG Entertainment",
  mono = false,
  ...props
}: React.ComponentProps<"svg"> & { title?: string; mono?: boolean }) {
  const stroke = mono ? "none" : "var(--gg-ink)"
  return (
    <svg
      data-slot="gg-logo"
      viewBox={LOGO.viewBox}
      role="img"
      aria-label={title}
      className={cn("h-6 w-auto", className)}
      {...props}
    >
      <path
        d={LOGO.paper}
        fill={mono ? "currentColor" : "var(--gg-paper)"}
        stroke={stroke}
        strokeWidth={LOGO.stroke}
        strokeLinejoin="round"
        paintOrder="stroke"
      />
      <path
        d={LOGO.volt}
        fill={mono ? "currentColor" : "var(--volt)"}
        stroke={stroke}
        strokeWidth={LOGO.stroke}
        strokeLinejoin="round"
        paintOrder="stroke"
      />
    </svg>
  )
}

/**
 * The volt G on its own, the logo's second letter, for the places a lockup
 * would not fit: a 40 x 20 mm label, the favicon. It inherits its colour from
 * the text and carries the same ink outline unless `outline` is off.
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
      viewBox={G.viewBox}
      role="img"
      aria-label={title}
      className={cn("h-6 w-auto text-volt", className)}
      {...props}
    >
      <path
        d={G.d}
        fill="currentColor"
        stroke={outline ? "var(--gg-ink)" : "none"}
        strokeWidth={outline ? G.stroke : 0}
        strokeLinejoin="round"
        paintOrder="stroke"
      />
    </svg>
  )
}

type WordmarkProps = React.ComponentProps<"span"> & {
  /** Puts the logo lockup in front of the letters, which then drop their own "GG". */
  mark?: boolean
  /** The product name. Change it here once if the working name changes. */
  name?: string
}

/**
 * "GG VAULT" in Space Mono 700, tracked .28em, 13px. Top left of every
 * screen. With `mark` the lockup supplies the GG, so the letters read
 * "VAULT" beside it (and "MY VAULT" stays whole); a screen reader still
 * hears the full name.
 */
function Wordmark({
  className,
  mark = false,
  name = "GG Vault",
  ...props
}: WordmarkProps) {
  const letters = mark ? name.replace(/^GG\s+/i, "") : name
  return (
    <span
      data-slot="wordmark"
      className={cn("inline-flex items-center gap-2.5 text-foreground", className)}
      {...props}
    >
      {mark ? <GGLogo aria-hidden="true" className="h-[1.125rem]" /> : null}
      <span className="font-mono text-[13px] leading-none font-bold tracking-[0.28em] uppercase">
        {letters !== name ? <span className="sr-only">{name.slice(0, name.length - letters.length)}</span> : null}
        {letters}
      </span>
    </span>
  )
}

export { Wordmark, GGLogo, GMark }
export type { WordmarkProps }
