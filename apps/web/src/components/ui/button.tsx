import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { ArrowRightIcon } from "lucide-react"

import { RingSpinner } from "@/components/ui/icons"

const buttonVariants = cva(
  [
    "group/button relative inline-flex shrink-0 items-center justify-center whitespace-nowrap select-none outline-none",
    "transition-[background-color,color,opacity,transform] duration-150 ease-gg",
    "active:translate-y-px disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        /** The one primary action on a screen: a 56px black block. */
        block:
          "h-14 min-w-44 gap-3 rounded-none bg-primary px-10 font-mono text-[12px] font-bold tracking-[0.16em] text-primary-foreground uppercase hover:bg-primary-hover [&_svg]:size-4 [&_svg]:stroke-[1.5]",
        /** The same action as a 56px circle, used beside a MicroLabel. */
        circle:
          "size-14 rounded-full bg-primary text-primary-foreground hover:bg-primary-hover [&_svg]:size-5 [&_svg]:stroke-[1.5]",
        /** Secondary actions: tracked micro-text with an underline on hover. */
        text: "h-auto gap-2 rounded-none bg-transparent p-0 font-mono text-[11px] font-bold tracking-[0.16em] text-foreground uppercase after:absolute after:inset-x-0 after:-bottom-1 after:h-px after:origin-left after:scale-x-0 after:bg-foreground after:transition-transform after:duration-150 after:ease-gg hover:after:scale-x-100 [&_svg]:size-4 [&_svg]:stroke-[1.25]",
        /** Destroying something: the same link in the error colour. */
        "text-destructive":
          "h-auto gap-2 rounded-none bg-transparent p-0 font-mono text-[11px] font-bold tracking-[0.16em] text-destructive uppercase after:absolute after:inset-x-0 after:-bottom-1 after:h-px after:origin-left after:scale-x-0 after:bg-destructive after:transition-transform after:duration-150 after:ease-gg hover:after:scale-x-100 [&_svg]:size-4 [&_svg]:stroke-[1.25]",
        /** A bare 40px icon target: close, more, back. */
        "ghost-icon":
          "size-10 rounded-[var(--radius)] bg-transparent text-foreground hover:bg-secondary [&_svg]:size-5 [&_svg]:stroke-[1.25]",
      },
    },
    defaultVariants: { variant: "block" },
  }
)

type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    /**
     * Swaps the arrow for a thin ring and disables the control. Blocking
     * pointer events alone let a keyboard submit the form twice, so a
     * loading button is a disabled button.
     */
    loading?: boolean
    /** `block` only. `circle` always carries one. */
    trailingArrow?: boolean
  }

function Button({
  className,
  variant = "block",
  loading = false,
  trailingArrow = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const isCircle = variant === "circle"
  const showArrow = isCircle || (variant === "block" && trailingArrow)

  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant}
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      disabled={disabled || loading || undefined}
      className={cn(buttonVariants({ variant, className }))}
      {...props}
    >
      {isCircle ? (
        children ? (
          <span className="sr-only">{children}</span>
        ) : null
      ) : (
        children
      )}
      {loading ? (
        <RingSpinner className={isCircle ? "size-5" : "size-4"} />
      ) : showArrow ? (
        <ArrowRightIcon aria-hidden="true" />
      ) : null}
    </ButtonPrimitive>
  )
}

export { Button, buttonVariants }
export type { ButtonProps }
