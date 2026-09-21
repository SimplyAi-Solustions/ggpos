import * as React from "react"
import { cn } from "cn"

/**
 * The small grey line under a row or a figure.
 *
 * `Hint` is the tracked Space Mono micro-label, and DESIGN.md is firm on two
 * things it therefore cannot carry: money is never set in Space Mono, and an
 * uppercase run longer than about 24 characters stops being readable. A date
 * beside a reference, a balance beside a hold, or a sentence about the email
 * address is all three, so My Vault says those in Jost instead.
 */
export function Note({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="portal-note"
      className={cn(
        "block text-[13px] leading-[1.45] text-muted-foreground-2",
        className
      )}
      {...props}
    />
  )
}
