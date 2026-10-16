/**
 * Where you are in the category tree: Space Mono micro-labels separated by a
 * thin chevron, the last one ink (docs/api-contract-inventory.md, section
 * 1.6). Every step but the last is a button back up to it. Used by the
 * picker, the till's branch view and the Sales report's drill-down.
 */
import { ChevronRightIcon } from "lucide-react"
import { cn } from "cn"

import { microVariants } from "@/components/ui/micro-label"

export interface BreadcrumbStep {
  id: string
  name: string
}

export function Breadcrumb({
  steps,
  onStep,
  label,
  className,
  testId,
}: {
  steps: BreadcrumbStep[]
  /** Called with a step's id when somebody goes back up to it. */
  onStep: (id: string) => void
  /** What the trail is, for a screen reader: "Branch", "Where you are". */
  label: string
  className?: string
  testId?: string
}) {
  return (
    <nav aria-label={label} className={className} data-testid={testId}>
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        {steps.map((step, index) => {
          const last = index === steps.length - 1
          return (
            <li key={`${step.id}-${index}`} className="flex min-w-0 items-center gap-1.5">
              {index > 0 ? (
                <ChevronRightIcon
                  aria-hidden="true"
                  className="size-3 shrink-0 stroke-[1.25] text-muted-foreground-2"
                />
              ) : null}
              {last ? (
                <span
                  aria-current="page"
                  className={cn(microVariants({ tone: "ink" }), "inline truncate py-2")}
                >
                  {step.name}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onStep(step.id)}
                  className={cn(
                    microVariants({ tone: "default" }),
                    "inline min-h-11 truncate rounded-[var(--radius)] underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline"
                  )}
                >
                  {step.name}
                </button>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
