import * as React from "react"
import { animate, useReducedMotion } from "motion/react"
import { formatGBP, roundHalfUp } from "@gg/shared/money"

import { cn } from "@/lib/cn"

export interface MoneyProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Integer pence. */
  pence: number
  /** Counts up or down to a new amount instead of jumping. For totals. */
  tween?: boolean
  size?: "sm" | "md" | "lg" | "xl"
  tone?: "default" | "muted" | "volt" | "pop" | "ok"
}

const sizes = {
  sm: "text-sm",
  md: "text-base",
  lg: "text-2xl font-bold",
  xl: "text-4xl font-bold tracking-tight sm:text-5xl",
}

const tones = {
  default: "text-fg",
  muted: "text-fg-2",
  // Volt as text only works on dark; in light it falls back to ink.
  volt: "text-fg dark:text-volt",
  pop: "text-pop-text",
  ok: "text-ok",
}

/** Animates between whole-penny values. Exported for its test. */
export function useTweenedPence(target: number, enabled: boolean): number {
  const reduce = useReducedMotion()
  const [shown, setShown] = React.useState(target)
  const fromRef = React.useRef(target)

  React.useEffect(() => {
    if (!enabled || reduce) {
      // The hook returns `target` directly in this case; only the start
      // point of the next tween needs to move.
      fromRef.current = target
      return
    }
    const controls = animate(fromRef.current, target, {
      duration: 0.6,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (latest) => {
        const pence = roundHalfUp(latest)
        fromRef.current = pence
        setShown(pence)
      },
    })
    return () => controls.stop()
  }, [target, enabled, reduce])

  return enabled && !reduce ? shown : target
}

/** A GBP amount as £1,234.56, set in Space Mono with tabular numbers. */
export function Money({
  pence,
  tween = false,
  size = "md",
  tone = "default",
  className,
  ...rest
}: MoneyProps) {
  const shown = useTweenedPence(pence, tween)
  return (
    <span
      className={cn("font-mono tnum whitespace-nowrap", sizes[size], tones[tone], className)}
      {...rest}
    >
      {/* Screen readers get the final figure, not every frame of the tween. */}
      <span aria-hidden={tween || undefined}>{formatGBP(shown)}</span>
      {tween && <span className="sr-only">{formatGBP(pence)}</span>}
    </span>
  )
}
