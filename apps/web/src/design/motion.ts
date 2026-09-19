/**
 * GG Vault motion presets.
 *
 * One easing (the marketing site's out-expo), two durations, four moments:
 * a page fades and rises, a list settles in, a focused underline grows from the
 * left, a number counts up once. No bounce, no elastic, nothing springy.
 * Everything here is switched off by `prefers-reduced-motion`.
 */

import * as React from "react"
import { animate, useReducedMotion, type MotionProps } from "motion/react"

type Variants = NonNullable<MotionProps["variants"]>
type Transition = NonNullable<MotionProps["transition"]>

/** cubic-bezier(.16, 1, .3, 1) - the site's out-expo. */
export const EASE_GG = [0.16, 1, 0.3, 1] as const

export const DURATION = {
  /** 150ms: state changes on a control you are touching. */
  fast: 0.15,
  /** 200ms: something entering or leaving the page. */
  base: 0.2,
} as const

/** 20ms between rows, as the plan asks. */
export const STAGGER = 0.02

export const transition = {
  fast: { duration: DURATION.fast, ease: EASE_GG },
  base: { duration: DURATION.base, ease: EASE_GG },
} satisfies Record<string, Transition>

/** Page and section entrances: fade and rise 8px. */
export const pageRise: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: transition.base },
  exit: { opacity: 0, y: -4, transition: transition.fast },
}

/** Put on the list; children use `listItem`. */
export const listContainer: Variants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: STAGGER, delayChildren: 0.02 },
  },
}

export const listItem: Variants = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: transition.base },
}

/** The focused field's underline grows from the left. */
export const underlineGrow: Variants = {
  hidden: { scaleX: 0 },
  visible: { scaleX: 1, transition: transition.fast },
}

/** Sheets and dialogs. */
export const panelRise: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: transition.base },
  exit: { opacity: 0, y: 8, transition: transition.fast },
}

/** The done seal on a success screen. Scale only, no overshoot. */
export const sealIn: Variants = {
  hidden: { opacity: 0, scale: 0.94 },
  visible: { opacity: 1, scale: 1, transition: transition.base },
}

const STILL: Variants = {
  hidden: { opacity: 1 },
  visible: { opacity: 1 },
  exit: { opacity: 1 },
}

/**
 * Wrap any variant set so it becomes a no-op when the reader has asked for
 * less motion. Returns the same shape either way, so call sites never branch.
 */
export function useMotionVariants(variants: Variants): Variants {
  const reduced = useReducedMotion()
  return reduced ? STILL : variants
}

/** `true` when every animation in the tree should be skipped. */
export function useReducedMotionGuard(): boolean {
  return useReducedMotion() ?? false
}

export type CountUpOptions = {
  /** Seconds. Defaults to 0.6, longer than a state change but still once. */
  duration?: number
  /** Decimal places to hold while counting, for money. */
  decimals?: number
}

/**
 * Counts a KPI figure up once when it changes. Reduced motion jumps straight
 * to the value. Returns a formatted string so `tnum` keeps the width steady.
 */
export function useCountUp(value: number, options: CountUpOptions = {}): string {
  const { duration = 0.6, decimals = 0 } = options
  const reduced = useReducedMotion()
  const [display, setDisplay] = React.useState(value)
  const previous = React.useRef(value)

  React.useEffect(() => {
    const from = previous.current
    previous.current = value

    if (reduced || from === value) {
      setDisplay(value)
      return
    }

    const controls = animate(from, value, {
      duration,
      ease: EASE_GG,
      onUpdate: (latest) => setDisplay(latest),
    })

    return () => controls.stop()
  }, [value, duration, reduced])

  return display.toFixed(decimals)
}
