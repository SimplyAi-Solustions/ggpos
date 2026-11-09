import * as React from "react"

import { cn } from "@/lib/cn"
import { G, LOGO } from "@/brand/logo-paths"

/**
 * The GG Entertainment lockup, a paper G and a volt G with the logo's ink
 * outline, from the same traced paths apps/web uses (logo-paths.ts, made by
 * apps/web/scripts/trace-logo.mjs from apps/web/src/design/brand/logo.png).
 * The outline is drawn under the fill, so on ink it merges with the
 * background and reads as the site's dark logo with nothing to switch.
 */
export function GGLogo({
  className,
  title = "GG Entertainment",
  ...props
}: React.ComponentProps<"svg"> & { title?: string }) {
  return (
    <svg viewBox={LOGO.viewBox} role="img" aria-label={title} className={cn("h-7 w-auto", className)} {...props}>
      {[
        { d: LOGO.paper, fill: "var(--paper)" },
        { d: LOGO.volt, fill: "var(--volt)" },
      ].map((path) => (
        <path
          key={path.fill}
          d={path.d}
          fill={path.fill}
          stroke="var(--ink)"
          strokeWidth={LOGO.stroke}
          strokeLinejoin="round"
          paintOrder="stroke"
        />
      ))}
    </svg>
  )
}

/** The volt G on its own, for tight spots like the rail. */
export function GMark({ className, title = "GG Entertainment", ...props }: React.ComponentProps<"svg"> & { title?: string }) {
  return (
    <svg viewBox={G.viewBox} role="img" aria-label={title} className={cn("h-7 w-auto", className)} {...props}>
      <path
        d={G.d}
        fill="var(--volt)"
        stroke="var(--ink)"
        strokeWidth={G.stroke}
        strokeLinejoin="round"
        paintOrder="stroke"
      />
    </svg>
  )
}

/** The lockup plus "VAULT" in tracked Space Mono, top left of every screen. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5 text-fg", className)}>
      <GGLogo aria-hidden="true" className="h-6" />
      <span className="font-mono text-[13px] leading-none font-bold tracking-[0.28em] uppercase">
        <span className="sr-only">GG </span>Vault
      </span>
    </span>
  )
}
