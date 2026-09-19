import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

/**
 * The tracked uppercase micro-text that carries almost every label in GG Vault:
 * section headings, field labels, helper text, button labels, column headings
 * and footer copy. Space Mono 700, 11px, .16em - the marketing site's eyebrow.
 */
const microVariants = cva(
  "block font-mono text-[11px] leading-[1.4] font-bold tracking-[0.16em] uppercase",
  {
    variants: {
      tone: {
        /** Field and control labels. */
        default: "text-muted-foreground",
        /** Section headings and anything that has to hold the page. */
        ink: "text-foreground",
        /** Helper text: "PRESS ENTER", "REQUIRED", "0 / 200". */
        hint: "text-muted-foreground-2",
        /** Errors and expiring offers. */
        alert: "text-destructive",
      },
    },
    defaultVariants: { tone: "default" },
  }
)

type MicroProps = React.ComponentProps<"span"> & VariantProps<typeof microVariants>

function MicroLabel({ className, tone, ...props }: MicroProps) {
  return (
    <span
      data-slot="micro-label"
      className={cn(microVariants({ tone }), className)}
      {...props}
    />
  )
}

/**
 * Introduces a block of fields. 32px of air above it, none below beyond the
 * field's own spacing - sections are divided by whitespace, never by rules.
 */
function SectionHeading({
  className,
  ...props
}: React.ComponentProps<"h2"> & { className?: string }) {
  return (
    <h2
      data-slot="section-heading"
      className={cn(
        microVariants({ tone: "ink" }),
        "mt-8 mb-5 first:mt-0",
        className
      )}
      {...props}
    />
  )
}

/** Right-aligned helper text beside a field. */
function Hint({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="hint"
      className={cn(microVariants({ tone: "hint" }), className)}
      {...props}
    />
  )
}

export { MicroLabel, SectionHeading, Hint, microVariants }
