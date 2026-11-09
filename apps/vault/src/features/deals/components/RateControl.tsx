import * as React from "react"
import { Check, ChevronDown } from "lucide-react"

import { cn } from "@/lib/cn"
import { PercentStepper } from "@/ui"

import { RATE_MAX, RATE_MIN, RATE_PRESETS } from "../state"

export interface RateControlProps {
  label: string
  value: number
  onChange: (pct: number) => void
  tone: "pop" | "volt"
}

/** A sweep rate: the kit's stepper plus a preset menu (Market, 90 to 60, Custom). */
export function RateControl({ label, value, onChange, tone }: RateControlProps) {
  const [open, setOpen] = React.useState(false)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const menuId = React.useId()

  React.useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("pointerdown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  const custom = () => {
    setOpen(false)
    // Custom: type the figure straight into the stepper.
    const input = rootRef.current?.querySelector<HTMLInputElement>("input")
    input?.focus()
  }

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1">
      <PercentStepper
        label={label}
        value={value}
        onChange={onChange}
        tone={tone}
        min={RATE_MIN}
        max={RATE_MAX}
      />
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((v) => !v)}
        className="label-mono absolute top-0 right-0 flex h-[17px] items-center gap-0.5 rounded-sm text-fg-3 hover:text-fg"
      >
        Presets
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={`${label} presets`}
          className="absolute top-[calc(100%+6px)] right-0 z-40 w-44 overflow-hidden rounded-md border border-line-2 bg-bg-2 p-1 shadow-sheet"
        >
          {RATE_PRESETS.map((preset) => {
            const active = preset.pct === value
            return (
              <button
                key={preset.pct}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  onChange(preset.pct)
                  setOpen(false)
                }}
                className={cn(
                  "flex h-10 w-full items-center justify-between rounded-sm px-3 text-left text-sm hover:bg-line",
                  active && "font-semibold"
                )}
              >
                <span>
                  {preset.label}
                  {preset.pct === 100 && <span className="ml-1.5 font-mono text-xs text-fg-3 tnum">100%</span>}
                </span>
                {active && (
                  <Check className={cn("size-4", tone === "pop" ? "text-pop-text" : "text-fg")} aria-hidden />
                )}
              </button>
            )
          })}
          <button
            type="button"
            role="menuitem"
            onClick={custom}
            className="flex h-10 w-full items-center rounded-sm border-t border-line px-3 text-left text-sm hover:bg-line"
          >
            Custom
          </button>
        </div>
      )}
    </div>
  )
}
