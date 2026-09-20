/**
 * An underlined amount with the pound sign as its leading glyph, the same
 * field Add stock uses for cost and price. It tidies 4.5 into 4.50 when it is
 * left, so a column of amounts lines up without anybody retyping.
 */
import * as React from "react"
import { formatGBP, parseDecimalToMinor } from "@gg/shared"

import { Input } from "@/components/ui/input"

export interface MoneyInputProps {
  id?: string
  value: string
  onChange: (next: string) => void
  onBlur?: () => void
  invalid?: boolean
  autoFocus?: boolean
  placeholder?: string
  "aria-label"?: string
  inputRef?: React.Ref<HTMLInputElement>
}

export function MoneyInput({
  id,
  value,
  onChange,
  onBlur,
  invalid,
  autoFocus,
  placeholder = "0.00",
  inputRef,
  ...rest
}: MoneyInputProps) {
  return (
    <Input
      id={id}
      ref={inputRef}
      inputMode="decimal"
      autoComplete="off"
      autoFocus={autoFocus}
      className="tnum"
      aria-invalid={invalid || undefined}
      aria-label={rest["aria-label"]}
      leadingIcon={
        <span aria-hidden="true" className="text-[18px] leading-none">
          &pound;
        </span>
      }
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onBlur={() => {
        const pence = parseDecimalToMinor(value)
        if (pence !== null) onChange(formatGBP(pence).replace("£", "").replace(/,/g, ""))
        onBlur?.()
      }}
    />
  )
}

/** "12.50" from 1250, for seeding a field from a stored amount. */
export function penceToField(pence: number): string {
  return formatGBP(pence).replace("£", "").replace(/,/g, "")
}
