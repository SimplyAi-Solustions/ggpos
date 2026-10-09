/**
 * A hairline square, ticked in ink: the system has no checkbox of its own,
 * so this is the one the Exports screen draws, for choosing rows to file.
 */
import { CheckIcon } from "lucide-react"

export function RowCheck({
  checked,
  onChange,
  label,
  testId,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  testId?: string
}) {
  return (
    <span className="relative flex size-5 shrink-0 items-center justify-center">
      <input
        type="checkbox"
        aria-label={label}
        data-testid={testId}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        onClick={(event) => event.stopPropagation()}
        className="peer size-5 cursor-pointer appearance-none rounded-[var(--radius)] border border-hairline bg-transparent outline-none checked:border-primary checked:bg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt"
      />
      <CheckIcon
        aria-hidden="true"
        className="pointer-events-none absolute size-3.5 stroke-[2] text-primary-foreground opacity-0 peer-checked:opacity-100"
      />
    </span>
  )
}
