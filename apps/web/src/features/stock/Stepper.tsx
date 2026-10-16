import { MinusIcon, PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/**
 * A quantity: thin minus and plus either side of an underline field.
 *
 * The field can be left empty (`""`), which is how Add more of this asks
 * for the count that came in rather than guessing one; minus does nothing
 * from empty and plus starts at 1. The form behind it says so if it is
 * saved empty.
 */
export function Stepper({
  id,
  value,
  onChange,
  disabled,
  label,
}: {
  id: string
  value: number | ""
  onChange: (next: number | "") => void
  disabled?: boolean
  /** For a stepper with no `Field` label pointing at it. */
  label?: string
}) {
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost-icon"
        type="button"
        aria-label="One fewer"
        disabled={disabled || value === "" || value <= 1}
        onClick={() => onChange(value === "" ? 1 : Math.max(1, value - 1))}
      >
        <MinusIcon />
      </Button>
      <Input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        aria-label={label}
        disabled={disabled}
        containerClassName="w-16"
        className="tnum text-center"
        value={value === "" ? "" : String(value)}
        onChange={(event) => {
          const digits = event.target.value.replace(/\D/g, "")
          if (!digits) {
            onChange("")
            return
          }
          const next = Number(digits)
          onChange(Number.isSafeInteger(next) && next > 0 ? next : 1)
        }}
      />
      <Button
        variant="ghost-icon"
        type="button"
        aria-label="One more"
        disabled={disabled}
        onClick={() => onChange(value === "" ? 1 : value + 1)}
      >
        <PlusIcon />
      </Button>
    </div>
  )
}
