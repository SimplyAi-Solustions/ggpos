import * as React from "react"
import { cn } from "cn"

/**
 * The plain label element, styled as GG micro-text. Most forms should reach
 * for `Field` instead, which owns the label, hint and error together.
 */
function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        "inline-flex items-center gap-2 font-mono text-[11px] leading-[1.4] font-bold tracking-[0.16em] text-muted-foreground uppercase select-none",
        "group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50",
        "peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Label }
