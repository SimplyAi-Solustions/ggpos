import { cn } from "cn"

import type { TimelineStep } from "@/features/portal/timeline"

/**
 * A quote's progress, drawn as a hairline rail with a marker per step.
 *
 * Status is never carried by colour alone: the current step is the only one
 * in ink at full weight, it carries `aria-current="step"`, and it is the only
 * one with a sentence under it. A stopped step keeps the same marker and says
 * what happened in words, so a red dot is never the whole message.
 */
export function Timeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <ol className="flex flex-col">
      {steps.map((step, index) => {
        const last = index === steps.length - 1
        const reached = step.state === "done" || step.state === "current"
        return (
          <li
            key={step.key}
            aria-current={step.state === "current" ? "step" : undefined}
            className="relative grid grid-cols-[1.25rem_1fr] gap-x-4"
          >
            <div className="flex flex-col items-center">
              <span
                aria-hidden="true"
                className={cn(
                  "mt-1.5 size-2.5 shrink-0 rounded-full",
                  step.state === "current"
                    ? "bg-foreground"
                    : reached
                      ? "bg-muted-foreground-2"
                      : "border border-hairline bg-background",
                  step.state === "stopped" && "bg-foreground"
                )}
              />
              {!last ? (
                <span
                  aria-hidden="true"
                  className="w-px flex-1 bg-hairline-soft"
                  style={{ minHeight: 28 }}
                />
              ) : null}
            </div>
            <div className={cn("pb-6", last && "pb-0")}>
              <span
                className={cn(
                  "block text-[15px] leading-[1.4]",
                  step.state === "current" || step.state === "stopped"
                    ? "font-medium text-foreground"
                    : reached
                      ? "text-muted-foreground"
                      : "text-muted-foreground-2"
                )}
              >
                {step.label}
              </span>
              {step.detail ? (
                <span className="mt-1 block max-w-[48ch] text-[15px] leading-[1.5] text-muted-foreground">
                  {step.detail}
                </span>
              ) : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
