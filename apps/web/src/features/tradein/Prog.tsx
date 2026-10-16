import { cn } from "cn"

import { STEP_LABEL, type WizardStep } from "@/features/tradein/machine"

export interface ProgProps {
  steps: WizardStep[]
  current: WizardStep
  /** Jump back to a step already finished. Forward is never a link. */
  onGo?: (step: WizardStep) => void
  className?: string
}

/**
 * The wizard's segmented progress: one hairline segment per step, filled ink
 * once it is behind you, with its name in Space Mono underneath.
 *
 * It is a list, not a set of buttons, except for the steps already done,
 * which are the only ones that can be gone back to. On a phone the labels
 * drop to the two that matter, so five names never wrap into two lines.
 */
export function Prog({ steps, current, onGo, className }: ProgProps) {
  const index = steps.indexOf(current)

  return (
    <nav aria-label="Buy-in progress" className={cn("w-full", className)}>
      <ol className="flex items-stretch gap-2">
        {steps.map((step, position) => {
          const done = position < index
          const now = position === index
          const label = STEP_LABEL[step]
          return (
            <li key={step} className="flex min-w-0 flex-1 flex-col gap-2">
              <span
                aria-hidden="true"
                className={cn(
                  "h-[3px] w-full transition-colors duration-150 ease-gg",
                  done || now ? "bg-foreground" : "bg-hairline"
                )}
              />
              {done && onGo ? (
                <button
                  type="button"
                  onClick={() => onGo(step)}
                  className="truncate text-left font-mono text-[11px] leading-[1.4] font-bold tracking-[0.16em] text-muted-foreground uppercase underline-offset-4 outline-none hover:text-foreground hover:underline max-[560px]:sr-only"
                >
                  {label}
                </button>
              ) : (
                <span
                  aria-current={now ? "step" : undefined}
                  className={cn(
                    "truncate font-mono text-[11px] leading-[1.4] font-bold tracking-[0.16em] uppercase",
                    now ? "text-foreground" : "text-muted-foreground-2",
                    now ? "" : "max-[560px]:sr-only"
                  )}
                >
                  {label}
                </span>
              )}
            </li>
          )
        })}
      </ol>
      <p className="mt-2 font-mono text-[11px] leading-[1.4] font-bold tracking-[0.16em] text-muted-foreground-2 uppercase min-[560px]:sr-only">
        Step {index + 1} of {steps.length}
      </p>
    </nav>
  )
}
