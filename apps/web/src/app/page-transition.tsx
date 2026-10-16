import * as React from "react"
import { useRouterState } from "@tanstack/react-router"
import { motion } from "motion/react"

import { pageRise, useMotionVariants } from "@/design/motion"

/**
 * The page fade and rise, the one entrance the plan asks for: a screen comes
 * in at opacity 0 and 8px low and settles in 200ms on the site's out-expo.
 *
 * It keys on the matched route's id, so it plays once per screen and not
 * again when the same screen's own state changes, and it is `<main>` itself
 * rather than a wrapper, so no element is added between the column and the
 * screen. `useMotionVariants` returns a still set when the reader has asked
 * for less motion, so there is nothing to branch on here.
 *
 * Two things follow from that, both deliberate:
 *
 *  - A move that changes only a param keeps the same route id, so one report
 *    to another, or one item to the next, gets no entrance. Keying on the
 *    pathname would give those the entrance and would also remount the screen
 *    on a param change, losing anything half typed on the item page. The
 *    entrance is not worth that.
 *  - While `y` animates from 8 to 0, `<main>` carries a transform, so for
 *    those 200ms it is the containing block for any `position: fixed`
 *    descendant. Nothing inside a screen may be fixed and expect the viewport:
 *    the docked buttons portal into a slot outside main in both shells, and
 *    sheets and dialogs portal to the body. A fixed banner added inside a
 *    screen would slide 8px on arrival.
 */
function useRouteKey(): string {
  return useRouterState({
    select: (state) => state.matches[state.matches.length - 1]?.routeId ?? "",
  })
}

type MainProps = React.ComponentProps<typeof motion.main>

/** `<main>` with the page entrance on it. Props pass through untouched. */
export function PageMain({ children, ...props }: MainProps) {
  const routeKey = useRouteKey()
  const variants = useMotionVariants(pageRise)
  return (
    <motion.main
      key={routeKey}
      variants={variants}
      initial="hidden"
      animate="visible"
      {...props}
    >
      {children}
    </motion.main>
  )
}
