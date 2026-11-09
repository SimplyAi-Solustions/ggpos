import * as React from "react"
import { Sparkles } from "lucide-react"

import { Badge, Card, PageHeader } from "@/ui"

export interface FeaturePlaceholderProps {
  eyebrow: string
  title: string
  lede: string
  icon: React.ReactNode
  /** What the finished screen will do, one line each. */
  plans: string[]
  children?: React.ReactNode
}

/**
 * The branded stand-in every feature screen starts as. Feature agents
 * replace their own usage of it; nothing else depends on it.
 */
export function FeaturePlaceholder({ eyebrow, title, lede, icon, plans, children }: FeaturePlaceholderProps) {
  return (
    <section>
      <PageHeader eyebrow={eyebrow} title={title}>
        {lede}
      </PageHeader>
      <div className="grid gap-4 md:grid-cols-[1.1fr_1fr]">
        <Card tilt accent="volt" className="relative overflow-hidden p-6">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-16 -right-16 size-56 rounded-full bg-volt/25 blur-3xl dark:bg-volt/15"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-20 -left-10 size-48 rounded-full bg-pop/20 blur-3xl dark:bg-pop/15"
          />
          <div className="relative flex flex-col gap-4">
            <div className="flex size-14 items-center justify-center rounded-md bg-volt text-on-volt shadow-volt [&_svg]:size-7">
              {icon}
            </div>
            <Badge tone="pop" dot>
              Coming next
            </Badge>
            <p className="max-w-[40ch] text-fg-2">
              This screen is a placeholder. Its feature lives in its own folder, ready to build.
            </p>
          </div>
        </Card>
        <Card className="p-6">
          <p className="label-mono mb-3 flex items-center gap-2 text-fg-2">
            <Sparkles className="size-4 text-pop-text" aria-hidden />
            Planned
          </p>
          <ul className="flex flex-col gap-2.5">
            {plans.map((plan) => (
              <li key={plan} className="flex gap-3 text-[15px]">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-pop" aria-hidden />
                <span>{plan}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      {children && <div className="mt-4">{children}</div>}
    </section>
  )
}
