import * as React from "react"
import { cn } from "cn"

import { Hint, microVariants } from "@/components/ui/micro-label"

type FieldLayout =
  /** Label left from 900px, stacked below it. The Nova reference. */
  | "auto"
  /** Always label above control. The Atlas reference. */
  | "stacked"

type FieldProps = Omit<React.ComponentProps<"div">, "children"> & {
  label?: React.ReactNode
  /** Right-aligned micro-text on the label row: "REQUIRED", "OPTIONAL". */
  hint?: React.ReactNode
  /** A thin line icon in its own column, like the Atlas "DETAILS" row. */
  icon?: React.ReactNode
  /** Points the label at the control it labels. */
  htmlFor?: string
  /** Rendered under the control in the error colour. */
  error?: React.ReactNode
  layout?: FieldLayout
  children: React.ReactNode
}

/**
 * The only form layout in GG Vault. Sections are divided by whitespace, so a
 * Field owns its own spacing and never draws a rule, a box or a card.
 */
function Field({
  className,
  label,
  hint,
  icon,
  htmlFor,
  error,
  layout = "auto",
  children,
  ...props
}: FieldProps) {
  const labelBlock =
    label || hint ? (
      <div
        className={cn(
          "flex items-baseline justify-between gap-4",
          // Stacked, the label and its hint sit together at the top of the
          // column: `justify-between` would otherwise push the hint to the
          // foot of a tall field, away from the label it belongs to.
          layout === "auto"
            ? "pt-0 min-[900px]:flex-col min-[900px]:items-start min-[900px]:justify-start min-[900px]:gap-1 min-[900px]:pt-2"
            : ""
        )}
      >
        {label ? (
          <label
            data-slot="field-label"
            htmlFor={htmlFor}
            className={cn(microVariants({ tone: "default" }), "cursor-pointer")}
          >
            {label}
          </label>
        ) : (
          <span />
        )}
        {hint ? <Hint>{hint}</Hint> : null}
      </div>
    ) : null

  const body = (
    <div data-slot="field-body" className="min-w-0">
      {children}
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  )

  return (
    <div
      data-slot="field"
      data-layout={layout}
      className={cn(
        "grid w-full",
        icon ? "grid-cols-[1.25rem_1fr] gap-x-6" : "grid-cols-1",
        layout === "auto"
          ? icon
            ? "gap-y-1.5 min-[900px]:grid-cols-[1.25rem_10rem_1fr] min-[900px]:gap-x-6 min-[900px]:gap-y-0"
            : "gap-y-1 min-[900px]:grid-cols-[10rem_1fr] min-[900px]:gap-x-6 min-[900px]:gap-y-0"
          : "gap-y-1.5",
        className
      )}
      {...props}
    >
      {icon ? (
        <span
          data-slot="field-icon"
          aria-hidden="true"
          className={cn(
            "flex h-5 items-center text-foreground [&_svg]:size-5 [&_svg]:stroke-[1.25]",
            layout === "auto"
              ? "row-span-2 pt-0 min-[900px]:row-span-1 min-[900px]:pt-2"
              : "row-span-2"
          )}
        >
          {icon}
        </span>
      ) : null}
      {labelBlock}
      {body}
    </div>
  )
}

/** One line, under the control, saying what happened and what to do. */
function FieldError({ className, children, ...props }: React.ComponentProps<"p">) {
  if (!children) return null
  return (
    <p
      data-slot="field-error"
      role="alert"
      className={cn(
        "mt-2 font-sans text-[13px] leading-[1.45] text-destructive",
        className
      )}
      {...props}
    >
      {children}
    </p>
  )
}

/** Groups Fields with the reference's rhythm: 40px between rows. */
function FieldRow({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-row"
      className={cn("flex flex-col gap-10", className)}
      {...props}
    />
  )
}

export { Field, FieldError, FieldRow }
export type { FieldProps, FieldLayout }
