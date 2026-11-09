import * as React from "react"
import { Loader2 } from "lucide-react"

import { cn } from "@/lib/cn"

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "pop"
export type ButtonSize = "sm" | "md" | "lg"

const base =
  "relative inline-flex select-none items-center justify-center gap-2 font-sans font-semibold " +
  "transition-[background-color,box-shadow,transform,color,border-color] duration-200 ease-gg " +
  "active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45 whitespace-nowrap"

const variants: Record<ButtonVariant, string> = {
  // Volt is the primary action. Ink text on volt, never white.
  primary:
    "bg-volt text-on-volt shadow-volt hover:bg-volt-deep dark:hover:bg-volt dark:hover:brightness-110",
  secondary:
    "glass border border-line-2 text-fg hover:border-fg-3 hover:bg-panel-2",
  ghost: "text-fg hover:bg-line",
  danger: "bg-pop-text text-on-pop hover:brightness-110 dark:bg-pop",
  // Pink, for the trade-credit side and highlights.
  pop: "bg-pop text-on-pop hover:brightness-110 dark:[box-shadow:var(--glow-pop)]",
}

const sizes: Record<ButtonSize, string> = {
  sm: "h-9 rounded-sm px-3 text-sm",
  md: "h-12 rounded-md px-5 text-[15px]",
  lg: "h-14 rounded-md px-6 text-base",
}

export function buttonClasses(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  block = false
): string {
  return cn(base, variants[variant], sizes[size], block && "w-full")
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Full width. */
  block?: boolean
  /** Shows a spinner and disables the button. */
  loading?: boolean
  icon?: React.ReactNode
  iconRight?: React.ReactNode
}

export function Button({
  variant = "primary",
  size = "md",
  block = false,
  loading = false,
  icon,
  iconRight,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(buttonClasses(variant, size, block), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
      {iconRight}
    </button>
  )
}
