import * as React from "react"

import { cn } from "@/lib/cn"

export interface EmptyStateProps {
  icon?: React.ReactNode
  title: string
  children?: React.ReactNode
  action?: React.ReactNode
  className?: string
}

export function EmptyState({ icon, title, children, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line-2 px-6 py-12 text-center",
        className
      )}
    >
      {icon && (
        <div className="flex size-14 items-center justify-center rounded-full bg-volt text-on-volt shadow-volt [&_svg]:size-6">
          {icon}
        </div>
      )}
      <h2 className="font-display text-2xl uppercase tracking-wide">{title}</h2>
      {children && <div className="max-w-[42ch] text-fg-2">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
