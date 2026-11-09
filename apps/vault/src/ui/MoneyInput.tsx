import * as React from "react"
import { formatGBP, parseDecimalToMinor } from "@gg/shared/money"

import { cn } from "@/lib/cn"
import { Field, inputShell } from "@/ui/Input"

/** 1234 pence as "12.34", for editing. Integer maths only. */
export function penceToPlain(pence: number): string {
  const negative = pence < 0
  const abs = Math.abs(pence)
  return `${negative ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`
}

export interface MoneyInputProps {
  /** Integer pence, or null for empty. */
  value: number | null
  onChange: (pence: number | null) => void
  label?: string
  hint?: string
  error?: string | null
  placeholder?: string
  /** Allows a negative amount. Off by default. */
  allowNegative?: boolean
  size?: "md" | "lg"
  id?: string
  className?: string
  disabled?: boolean
  autoFocus?: boolean
  name?: string
}

/**
 * Pence in, pence out; pounds on screen. While focused the field holds what
 * was typed ("12.5"); on blur it settles to the formatted amount ("12.50",
 * "1,234.56"). Parsing is @gg/shared's parseDecimalToMinor, so no float ever
 * touches the amount.
 */
export function MoneyInput({
  value,
  onChange,
  label,
  hint,
  error,
  placeholder = "0.00",
  allowNegative = false,
  size = "md",
  id,
  className,
  disabled,
  autoFocus,
  name,
}: MoneyInputProps) {
  const [draft, setDraft] = React.useState<string | null>(null)
  const formatted = value === null ? "" : formatGBP(value).replace("£", "")
  const shown = draft ?? formatted

  let localError: string | null = null
  if (draft !== null && draft.trim() !== "") {
    const parsed = parseDecimalToMinor(draft)
    if (parsed === null) localError = "Enter an amount like 12.50."
    else if (parsed < 0 && !allowNegative) localError = "Enter an amount of £0.00 or more."
  }

  return (
    <Field label={label} hint={hint} error={error ?? localError} id={id} className={className}>
      {({ id: fieldId, describedBy, invalid }) => (
        <div
          className={cn(
            inputShell,
            size === "lg" && "h-16",
            invalid && "border-pop focus-within:border-pop"
          )}
        >
          <span
            className={cn("font-mono text-fg-3", size === "lg" ? "text-2xl" : "text-base")}
            aria-hidden
          >
            £
          </span>
          <input
            id={fieldId}
            name={name}
            inputMode="decimal"
            autoComplete="off"
            enterKeyHint="done"
            disabled={disabled}
            autoFocus={autoFocus}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            placeholder={placeholder}
            value={shown}
            onFocus={() => setDraft(value === null ? "" : penceToPlain(value))}
            onBlur={() => setDraft(null)}
            onChange={(event) => {
              const text = event.target.value
              setDraft(text)
              if (text.trim() === "") return onChange(null)
              const parsed = parseDecimalToMinor(text)
              if (parsed === null) return
              if (parsed < 0 && !allowNegative) return
              onChange(parsed)
            }}
            className={cn(
              "h-full min-w-0 flex-1 bg-transparent font-mono tnum text-fg outline-none placeholder:text-fg-3",
              size === "lg" ? "text-2xl" : "text-base"
            )}
          />
        </div>
      )}
    </Field>
  )
}
