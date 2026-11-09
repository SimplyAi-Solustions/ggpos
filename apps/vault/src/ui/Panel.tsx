import * as React from "react"
import { motion, useMotionValue, useSpring, useTransform } from "motion/react"

import { cn } from "@/lib/cn"

export interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Slightly raised surface, for a panel inside a panel. */
  raised?: boolean
  /** Removes the inner padding. */
  flush?: boolean
}

/** The base surface: paper card in light, frosted glass in dark. */
export function Panel({ raised, flush, className, ...rest }: PanelProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-line shadow-panel",
        raised ? "bg-panel-2" : "glass",
        !flush && "p-4 sm:p-5",
        className
      )}
      {...rest}
    />
  )
}

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Tilts towards the pointer on hover, like a card held in the hand. */
  tilt?: boolean
  /** Adds a volt or pop rim, for "ready" and "highlight" states. */
  accent?: "volt" | "pop"
}

/**
 * An interactive card: a Panel that can tilt on hover. The tilt follows a
 * fine pointer only, so it never fights a scroll on a phone.
 */
export function Card({ tilt = false, accent, className, children, ...rest }: CardProps) {
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const rotateX = useSpring(useTransform(y, [-0.5, 0.5], [7, -7]), { stiffness: 250, damping: 20 })
  const rotateY = useSpring(useTransform(x, [-0.5, 0.5], [-7, 7]), { stiffness: 250, damping: 20 })

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!tilt || event.pointerType !== "mouse") return
    const rect = event.currentTarget.getBoundingClientRect()
    x.set((event.clientX - rect.left) / rect.width - 0.5)
    y.set((event.clientY - rect.top) / rect.height - 0.5)
  }
  const onPointerLeave = () => {
    x.set(0)
    y.set(0)
  }

  return (
    <motion.div
      style={tilt ? { rotateX, rotateY, transformPerspective: 800 } : undefined}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      className={cn(
        "glass rounded-lg border border-line p-4 shadow-panel transition-[border-color,box-shadow] duration-300 ease-gg",
        accent === "volt" && "border-volt/70 dark:[box-shadow:var(--glow-volt)]",
        accent === "pop" && "border-pop/70 dark:[box-shadow:var(--glow-pop)]",
        className
      )}
      {...(rest as React.ComponentProps<typeof motion.div>)}
    >
      {children}
    </motion.div>
  )
}
