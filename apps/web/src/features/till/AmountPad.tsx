/**
 * An amount keyed on the till's money pad: the figure in a scan-sized
 * underline field, and the `Keypad` in money mode beside it on a tablet and
 * under it on a phone (DESIGN.md, section 10, "Paying"). On a phone the
 * order is the figure, the notes, the pad, then the step's block, so the
 * thumb works down the screen; on a tablet the pad stands to the right of
 * all of them.
 *
 * The value is a string of pence digits ("2000" is £20.00), which is what
 * `applyKey` builds, so no float ever touches it. A physical keyboard types
 * into it too (`captureKeyboard`), for the Mac at the counter.
 */
import * as React from "react"
import { formatGBP } from "@gg/shared"
import { cn } from "cn"

import { Keypad, applyKey, type KeypadKey } from "@/components/ui/keypad"
import { MicroLabel } from "@/components/ui/micro-label"
import { digitsToPence } from "@/features/till/icons"

/** Up to £99,999.99. */
const MAX_DIGITS = 7

export interface AmountPadProps {
  /** Pence as a digit string. */
  value: string
  onChange: (next: string) => void
  /** Names the figure and the pad, e.g. "Cash handed over". */
  label: string
  /** Enter on a physical keyboard. */
  onEnter?: () => void
  /** What the field shows while nothing is keyed. */
  placeholder?: string
  invalid?: boolean
  /** Under the figure: the quick notes, a balance. */
  children?: React.ReactNode
  /** Last: the step's block and its error. */
  actions?: React.ReactNode
  /** Keep the pad under the figure at every width (a sheet is narrow). */
  stacked?: boolean
  testId?: string
  className?: string
}

export function AmountPad({
  value,
  onChange,
  label,
  onEnter,
  placeholder = "£0.00",
  invalid = false,
  children,
  actions,
  stacked = false,
  testId,
  className,
}: AmountPadProps) {
  const id = React.useId()
  const onKey = (key: KeypadKey) => onChange(applyKey(value, key, MAX_DIGITS))
  const wide = !stacked

  return (
    <div
      className={cn(
        "grid gap-x-8 gap-y-6",
        wide && "min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(240px,300px)] min-[1100px]:grid-rows-[auto_1fr]",
        className
      )}
    >
      <div className="flex min-w-0 flex-col gap-5">
        <div>
          <MicroLabel id={`${id}-label`}>{label}</MicroLabel>
          <div
            data-testid={testId}
            role="status"
            aria-labelledby={`${id}-label`}
            aria-live="polite"
            className={cn(
              "relative mt-1.5 flex min-h-16 items-end pb-3",
              "text-[24px] leading-[1.3] font-light sm:text-[28px] sm:leading-[1.25] tnum",
              value ? "text-foreground" : "text-muted-foreground-2"
            )}
          >
            {value ? formatGBP(digitsToPence(value)) : placeholder}
            <span
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute inset-x-0 bottom-0 h-px bg-hairline",
                invalid && "h-[1.5px] bg-pop"
              )}
            />
          </div>
        </div>
        {children}
      </div>
      <Keypad
        mode="money"
        aria-label={label}
        onKey={onKey}
        onEnter={onEnter}
        captureKeyboard
        className={cn(wide && "min-[1100px]:col-start-2 min-[1100px]:row-span-2 min-[1100px]:row-start-1 min-[1100px]:self-start")}
      />
      {actions ? (
        <div
          className={cn(
            "flex min-w-0 flex-col gap-4",
            wide && "min-[1100px]:col-start-1 min-[1100px]:row-start-2"
          )}
        >
          {actions}
        </div>
      ) : null}
    </div>
  )
}
