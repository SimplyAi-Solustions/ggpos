import * as React from "react"

import { cn } from "@/lib/cn"

export interface ChipProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean
  icon?: React.ReactNode
}

/** A toggleable filter pill. Selected is ink on paper, paper on ink in dark. */
export function Chip({ selected, icon, className, children, type = "button", ...rest }: ChipProps) {
  return (
    <button
      type={type}
      aria-pressed={selected}
      className={cn(
        "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition-[background-color,color,border-color,transform] duration-200 ease-gg active:scale-95 [&_svg]:size-4",
        selected
          ? "border-transparent bg-ink text-paper dark:bg-paper dark:text-ink"
          : "border-line-2 bg-panel-2 text-fg-2 hover:border-fg-3 hover:text-fg",
        className
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
}
