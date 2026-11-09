import * as React from "react"
import { motion } from "motion/react"

import { cn } from "@/lib/cn"

export interface SegmentOption<T extends string> {
  value: T
  label: string
  icon?: React.ReactNode
}

export interface SegmentedProps<T extends string> {
  options: ReadonlyArray<SegmentOption<T>>
  value: T
  onChange: (value: T) => void
  /** Accessible name for the group. */
  label: string
  /** "pop" for the trade-credit side of a cash/credit switch. */
  tone?: "volt" | "pop" | "ink"
  size?: "sm" | "md"
  block?: boolean
  className?: string
}

/** A single-choice switch with a sliding pill. Arrow keys move the choice. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  tone = "ink",
  size = "md",
  block,
  className,
}: SegmentedProps<T>) {
  const pillId = React.useId()
  const pill =
    tone === "volt"
      ? "bg-volt"
      : tone === "pop"
        ? "bg-pop"
        : "bg-ink dark:bg-paper"
  const activeText =
    tone === "volt" ? "text-on-volt" : tone === "pop" ? "text-on-pop" : "text-paper dark:text-ink"

  const onKeyDown = (event: React.KeyboardEvent) => {
    const index = options.findIndex((o) => o.value === value)
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault()
      onChange(options[(index + 1) % options.length]!.value)
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault()
      onChange(options[(index - 1 + options.length) % options.length]!.value)
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex rounded-full border border-line bg-panel-2 p-1",
        block && "flex w-full",
        className
      )}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative flex flex-1 items-center justify-center gap-1.5 rounded-full font-medium transition-colors duration-200 [&_svg]:size-4",
              size === "sm" ? "h-8 px-3 text-sm" : "h-10 px-4 text-[15px]",
              active ? activeText : "text-fg-2 hover:text-fg"
            )}
          >
            {active && (
              <motion.span
                layoutId={pillId}
                className={cn("absolute inset-0 rounded-full", pill)}
                transition={{ type: "spring", stiffness: 500, damping: 38 }}
              />
            )}
            <span className="relative z-10 flex items-center gap-1.5">
              {option.icon}
              {option.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
