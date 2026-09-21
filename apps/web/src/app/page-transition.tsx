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
