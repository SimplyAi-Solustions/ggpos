import { ChevronDown } from "lucide-react"

import { cn } from "@/lib/cn"
import { Field, inputShell } from "@/ui"

export interface SelectFieldProps {
  label?: string
  value: string
  onChange: (value: string) => void
  options: readonly { value: string; label: string }[]
  /** Shown first, for "any". */
  placeholder?: string
  hint?: string
  error?: string | null
  className?: string
  compact?: boolean
  "aria-label"?: string
}

/** A native select in the kit's input shell: the phone's own picker, one-handed. */
export function SelectField({ label, value, onChange, options, placeholder, hint, error, className, compact, ...rest }: SelectFieldProps) {
  return (
    <Field label={label} hint={hint} error={error} className={className}>
      {({ id, describedBy, invalid }) => (
        <div className={cn(inputShell, "relative pr-9", compact && "h-10 rounded-full px-3.5 text-sm", invalid && "border-pop")}>
          <select
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            aria-label={rest["aria-label"]}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="h-full w-full min-w-0 appearance-none bg-transparent text-fg outline-none"
          >
            {placeholder !== undefined && <option value="">{placeholder}</option>}
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 size-4 text-fg-3" aria-hidden />
        </div>
      )}
    </Field>
  )
}
