/**
 * The three field shapes Settings uses over and over: an amount in pounds, a
 * whole percent and a plain count. Each one is the shared `Field` with the
 * right control in it, so the label column, the hint and the error line are
 * the same everywhere on the page and no screen hand-rolls the layout.
 */
import * as React from "react"

import { Field, FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MoneyInput } from "@/features/sell/money-input"

interface BaseProps {
  id: string
  label: string
  /** Right-aligned micro-text on the label row. */
  hint?: React.ReactNode
  value: string
  onChange: (next: string) => void
  error?: string
  /** One grey line under the control, for what the setting actually does. */
  note?: React.ReactNode
  className?: string
}

function Note({ children }: { children: React.ReactNode }) {
  if (!children) return null
  return (
    <p className="mt-2 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
      {children}
    </p>
  )
}

export function PoundsField({
  id,
  label,
  hint,
  value,
  onChange,
  error,
  note,
  className,
}: BaseProps) {
  return (
    <Field label={label} hint={hint} htmlFor={id} className={className}>
      <MoneyInput id={id} value={value} onChange={onChange} invalid={Boolean(error)} />
      <Note>{note}</Note>
      <FieldError>{error}</FieldError>
    </Field>
  )
}

export function PercentField({
  id,
  label,
  hint,
  value,
  onChange,
  error,
  note,
  className,
}: BaseProps) {
  return (
    <Field label={label} hint={hint} htmlFor={id} className={className}>
      <Input
        id={id}
        className="tnum"
        inputMode="numeric"
        autoComplete="off"
        maxLength={3}
        trailingHint="%"
        aria-invalid={Boolean(error) || undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <Note>{note}</Note>
      <FieldError>{error}</FieldError>
    </Field>
  )
}

export function CountField({
  id,
  label,
  hint,
  value,
  onChange,
  error,
  note,
  className,
}: BaseProps) {
  return (
    <Field label={label} hint={hint} htmlFor={id} className={className}>
      <Input
        id={id}
        className="tnum"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        aria-invalid={Boolean(error) || undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <Note>{note}</Note>
      <FieldError>{error}</FieldError>
    </Field>
  )
}

export function TextField({
  id,
  label,
  hint,
  value,
  onChange,
  error,
  note,
  className,
  placeholder,
  maxLength,
  type = "text",
  inputMode,
}: BaseProps & {
  placeholder?: string
  maxLength?: number
  type?: string
  inputMode?: React.ComponentProps<"input">["inputMode"]
}) {
  return (
    <Field label={label} hint={hint} htmlFor={id} className={className}>
      <Input
        id={id}
        type={type}
        inputMode={inputMode}
        autoComplete="off"
        maxLength={maxLength}
        placeholder={placeholder}
        aria-invalid={Boolean(error) || undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <Note>{note}</Note>
      <FieldError>{error}</FieldError>
    </Field>
  )
}
