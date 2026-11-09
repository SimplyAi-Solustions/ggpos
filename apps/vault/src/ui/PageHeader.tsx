import * as React from "react"

import { cn } from "@/lib/cn"

export interface PageHeaderProps {
  /** Small Space Mono line above the title. */
  eyebrow?: string
  /** The one Anton line on the screen. */
  title: string
  actions?: React.ReactNode
  children?: React.ReactNode
  className?: string
}

export function PageHeader({ eyebrow, title, actions, children, className }: PageHeaderProps) {
  return (
    <header className={cn("mb-5 flex flex-col gap-2", className)}>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          {eyebrow && <p className="label-mono mb-1 text-pop-text">{eyebrow}</p>}
          <h1 className="font-display text-[clamp(2rem,1.4rem+2.4vw,3rem)] leading-[0.95] uppercase tracking-wide">
            {title}
          </h1>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="max-w-[56ch] text-fg-2">{children}</div>}
    </header>
  )
}
