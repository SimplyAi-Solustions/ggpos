import * as React from "react"
import { cn } from "cn"

/**
 * One Anton line per page and no more. It is the single thing that makes a
 * monochrome screen read as GG rather than as a template.
 */
function PageTitle({ className, ...props }: React.ComponentProps<"h1">) {
  return (
    <h1
      data-slot="page-title"
      className={cn(
        "font-display text-[clamp(1.75rem,1.4rem+1.6vw,2.25rem)] leading-[1.05] tracking-[0.01em] text-foreground uppercase",
        className
      )}
      {...props}
    />
  )
}

/** The one-line subtitle under a page title. Never longer than 56 characters. */
function Lede({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="lede"
      className={cn(
        "mt-3 max-w-[56ch] text-base leading-[1.5] text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

export { PageTitle, Lede }
