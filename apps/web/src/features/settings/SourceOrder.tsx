/**
 * The valuation order, as a list you move a source up or down in.
 *
 * docs/PLAN.md, "Core flows and rules": UK first, always. The order here is
 * the order the adapters try, so the number at the front of each row is the
 * whole point of the control and the two arrows are the only thing that
 * changes it. Buttons rather than drag: a counter is used with one thumb on
 * a phone and with a keyboard on the shop PC, and both of those can press a
 * button.
 */
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import type { PriceSource } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { MicroLabel } from "@/components/ui/micro-label"
import { SOURCE_LABELS } from "@/features/settings/mapping"

export interface SourceOrderProps {
  label: string
  /** For the accessible names: "Move Cardmarket up in the card order". */
  scope: string
  value: PriceSource[]
  onChange: (next: PriceSource[]) => void
  testId?: string
}

function move(list: PriceSource[], from: number, to: number): PriceSource[] {
  const next = [...list]
  const [item] = next.splice(from, 1)
  if (item) next.splice(to, 0, item)
  return next
}

export function SourceOrder({ label, scope, value, onChange, testId }: SourceOrderProps) {
  return (
    <div>
      <MicroLabel>{label}</MicroLabel>
      <ol data-testid={testId} className="mt-3">
        {value.map((source, index) => (
          <li
            key={source}
            data-testid={testId ? `${testId}-row` : undefined}
            className="flex min-h-12 items-center gap-4 border-b border-hairline-soft py-2"
          >
            <span className="tnum w-6 shrink-0 font-mono text-[13px] text-muted-foreground-2">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 text-[15px] text-foreground">
              {SOURCE_LABELS[source]}
            </span>
            <Button
              variant="ghost-icon"
              aria-label={`Move ${SOURCE_LABELS[source]} up in the ${scope}`}
              disabled={index === 0}
              onClick={() => onChange(move(value, index, index - 1))}
            >
              <ChevronUpIcon />
            </Button>
            <Button
              variant="ghost-icon"
              aria-label={`Move ${SOURCE_LABELS[source]} down in the ${scope}`}
              disabled={index === value.length - 1}
              onClick={() => onChange(move(value, index, index + 1))}
            >
              <ChevronDownIcon />
            </Button>
          </li>
        ))}
      </ol>
    </div>
  )
}
