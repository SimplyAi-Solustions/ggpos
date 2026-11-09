import * as React from "react"
import { Minus, Plus } from "lucide-react"

import { cn } from "@/lib/cn"

export interface PercentStepperProps {
  /** Whole percent, for example 55 for 55%. */
  value: number
  onChange: (percent: number) => void
  label: string
  min?: number
  max?: number
  step?: number
  /** "pop" tints it for the trade-credit side. */
  tone?: "volt" | "pop"
  className?: string
  disabled?: boolean
}

export function clampPercent(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** A −/+ stepper with a typed value in the middle, used for buy rates. */
export function PercentStepper({
  value,
  onChange,
  label,
  min = 0,
  max = 100,
  step = 5,
  tone = "volt",
  className,
  disabled,
}: PercentStepperProps) {
  const id = React.useId()
  const [draft, setDraft] = React.useState<string | null>(null)

  const commit = (text: string) => {
    const parsed = Number.parseInt(text.replace(/[^\d-]/g, ""), 10)
    if (Number.isFinite(parsed)) onChange(clampPercent(parsed, min, max))
    setDraft(null)
  }

  const nudge = (delta: number) => onChange(clampPercent(value + delta, min, max))

  const ring = tone === "pop" ? "focus-within:border-pop" : "focus-within:border-volt"
  const accent = tone === "pop" ? "text-pop-text" : "text-fg"

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="label-mono text-fg-2">
        {label}
      </label>
      <div
        className={cn(
          "flex h-12 items-stretch overflow-hidden rounded-md border border-line-2 bg-panel-2 transition-colors",
          ring
        )}
      >
        <button
          type="button"
          aria-label={`Decrease ${label}`}
          disabled={disabled || value <= min}
          onClick={() => nudge(-step)}
          className="flex w-12 items-center justify-center text-fg-2 transition-colors hover:bg-line hover:text-fg active:scale-90 disabled:opacity-35"
        >
          <Minus className="size-5" aria-hidden />
        </button>
        <div className="flex flex-1 items-center justify-center border-x border-line">
          <input
            id={id}
            inputMode="numeric"
            disabled={disabled}
            value={draft ?? String(value)}
            onFocus={(event) => {
              setDraft(String(value))
              event.target.select()
            }}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit(event.currentTarget.value)
              if (event.key === "ArrowUp") {
                event.preventDefault()
                nudge(1)
              }
              if (event.key === "ArrowDown") {
                event.preventDefault()
                nudge(-1)
              }
            }}
            className={cn(
              "w-14 bg-transparent text-right font-mono text-lg font-bold tnum outline-none",
              accent
            )}
          />
          <span className={cn("font-mono text-lg font-bold", accent)} aria-hidden>
            %
          </span>
        </div>
        <button
          type="button"
          aria-label={`Increase ${label}`}
          disabled={disabled || value >= max}
          onClick={() => nudge(step)}
          className="flex w-12 items-center justify-center text-fg-2 transition-colors hover:bg-line hover:text-fg active:scale-90 disabled:opacity-35"
        >
          <Plus className="size-5" aria-hidden />
        </button>
      </div>
    </div>
  )
}
