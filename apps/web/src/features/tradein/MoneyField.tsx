import * as React from "react"
import { formatGBP, parseDecimalToMinor } from "@gg/shared"

import { Input } from "@/components/ui/input"

export interface MoneyFieldProps {
  id: string
  /** Integer GBP pence. */
  value: number
  onChange: (pence: number) => void
  label?: string
  invalid?: boolean
  placeholder?: string
  className?: string
}

/** Pence as the plain "12.50" a staff member types, with no group commas. */
function pounds(pence: number): string {
  return pence ? formatGBP(pence).replace("£", "").replace(/,/g, "") : ""
}

/**
 * An amount in pounds and pence with the pound sign as its leading glyph.
 *
 * The field holds the string the staff member is typing so a half-typed
 * "12." is not swallowed, and only hands back pence. Leaving the field tidies
 * 4.5 into 4.50, so a column of offers lines up without anybody retyping.
 */
export function MoneyField({
  id,
  value,
  onChange,
  label,
  invalid,
  placeholder = "0.00",
  className,
}: MoneyFieldProps) {
  const [draft, setDraft] = React.useState(() => pounds(value))
  // A figure changed from outside (an override, a prefill) replaces what is
  // in the box; a figure this field itself just reported does not. Adjusted
  // during render rather than in an effect, so the box never paints once
  // with the old number first.
  const [seen, setSeen] = React.useState(value)
  if (value !== seen) {
    setSeen(value)
    setDraft(pounds(value))
  }

  return (
    <Input
      id={id}
      inputMode="decimal"
      autoComplete="off"
      aria-label={label}
      aria-invalid={invalid || undefined}
      className={className ? `tnum ${className}` : "tnum"}
      leadingIcon={
        <span aria-hidden="true" className="text-[18px] leading-none">
          &pound;
        </span>
      }
      placeholder={placeholder}
      value={draft}
      onChange={(event) => {
        const next = event.target.value
        setDraft(next)
        const pence = parseDecimalToMinor(next)
        // Record what this field is about to report, so the value coming
        // back down does not look like an outside change and overwrite the
        // half-typed "12." still in the box.
        if (pence !== null) {
          setSeen(pence)
          onChange(pence)
        } else if (next.trim() === "") {
          setSeen(0)
          onChange(0)
        }
      }}
      onBlur={() => {
        const pence = parseDecimalToMinor(draft)
        if (pence !== null) setDraft(pounds(pence))
      }}
    />
  )
}
