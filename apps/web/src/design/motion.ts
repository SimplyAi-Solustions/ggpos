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

/** Which row is flashing, and the scan that started it. */
export interface ScanPulse {
  id: string
  /**
   * A counter, raised on every call. The same item scanned twice is the same
   * id, so the id alone cannot tell React anything changed; keying the bar on
   * the nonce is what makes the second scan of a sealed line flash again.
   */
  nonce: number
}

/**
 * A scanned row's underline flashes volt: the bar grows from the left with
 * `underlineGrow` and, inside an `AnimatePresence`, leaves the same way, 150ms
 * each. The second it holds in between is state rather than motion, so
 * nothing here runs longer than the 200ms budget. Returns the row that is
 * flashing and the call that starts it.
 */
export function useScanPulse(hold = 1000): [ScanPulse | null, (id: string) => void] {
  const [pulsing, setPulsing] = React.useState<ScanPulse | null>(null)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const nonce = React.useRef(0)

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const pulse = React.useCallback(
    (id: string) => {
      if (timer.current) clearTimeout(timer.current)
      nonce.current += 1
      setPulsing({ id, nonce: nonce.current })
      timer.current = setTimeout(() => setPulsing(null), hold)
    },
    [hold]
  )

  return [pulsing, pulse]
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
 * Counts a KPI figure up when it arrives or changes, over 600ms. Returns a
 * formatted string so `tnum` keeps the width steady.
 *
 * Reduced motion returns the figure itself, worked out during the render
 * rather than corrected afterwards in an effect: a tile whose value arrives
 * with the first render would otherwise paint one frame of the seeded zero,
 * and a reader who has asked for no motion has no count-up to make that zero
 * read as a starting point. They would see the day's takings as nothing.
 *
 * The count starts from the figure on screen, not from the last target, so a
 * value that changes mid-count carries on from where the eye is.
 */
export function useCountUp(value: number, options: CountUpOptions = {}): string {
  const { duration = 0.6, decimals = 0 } = options
  const reduced = useReducedMotion()
  const [display, setDisplay] = React.useState(value)
  // What is on screen right now, so an interrupted count carries on from
  // where the eye is rather than snapping back to the last target.
  const shown = React.useRef(value)

  React.useEffect(() => {
    const from = shown.current

    if (reduced || from === value) {
      shown.current = value
      setDisplay(value)
      return
    }

    const controls = animate(from, value, {
      duration,
      ease: EASE_GG,
      onUpdate: (latest) => {
        shown.current = latest
        setDisplay(latest)
      },
    })

    return () => controls.stop()
  }, [value, duration, reduced])

  return (reduced ? value : display).toFixed(decimals)
}
