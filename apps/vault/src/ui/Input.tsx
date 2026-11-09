import * as React from "react"

import { cn } from "@/lib/cn"

export interface FieldProps {
  label?: string
  hint?: string
  error?: string | null
  id?: string
  className?: string
  children: (props: { id: string; describedBy?: string; invalid: boolean }) => React.ReactNode
}

/** Label, control slot, hint and error, wired up for screen readers. */
export function Field({ label, hint, error, id, className, children }: FieldProps) {
  const autoId = React.useId()
  const fieldId = id ?? autoId
  const hintId = hint ? `${fieldId}-hint` : undefined
  const errorId = error ? `${fieldId}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={fieldId} className="label-mono text-fg-2">
          {label}
        </label>
      )}
      {children({ id: fieldId, describedBy, invalid: Boolean(error) })}
      {hint && !error && (
        <p id={hintId} className="text-sm text-fg-3">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm font-medium text-pop-text" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export const inputShell =
  "flex h-12 w-full items-center gap-2 rounded-md border border-line-2 bg-panel-2 px-3.5 " +
  "transition-[border-color,box-shadow] duration-200 ease-gg " +
  "focus-within:border-volt focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--volt)_30%,transparent)]"

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  label?: string
  hint?: string
  error?: string | null
  /** Icon or text shown before the value. */
  leading?: React.ReactNode
  /** Icon, button or text shown after the value. */
  trailing?: React.ReactNode
  /** Monospaced value, for codes and numbers. */
  mono?: boolean
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, leading, trailing, mono, className, id, ...rest },
  ref
) {
  return (
    <Field label={label} hint={hint} error={error} id={id} className={className}>
      {({ id: fieldId, describedBy, invalid }) => (
        <div
          className={cn(
            inputShell,
            invalid && "border-pop focus-within:border-pop"
          )}
        >
          {leading && <span className="flex shrink-0 text-fg-3 [&_svg]:size-5">{leading}</span>}
          <input
            ref={ref}
            id={fieldId}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            className={cn(
              "h-full min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-fg-3",
              mono && "font-mono tnum"
            )}
            {...rest}
          />
          {trailing && <span className="flex shrink-0 items-center text-fg-3">{trailing}</span>}
        </div>
      )}
    </Field>
  )
})
