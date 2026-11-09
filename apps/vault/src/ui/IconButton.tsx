import * as React from "react"

import { cn } from "@/lib/cn"

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: the accessible name, also shown as the tooltip. */
  label: string
  variant?: "ghost" | "secondary" | "primary"
  size?: "sm" | "md" | "lg"
  children: React.ReactNode
}

const variants = {
  ghost: "text-fg-2 hover:text-fg hover:bg-line",
  secondary: "glass border border-line-2 text-fg hover:bg-panel-2",
  primary: "bg-volt text-on-volt hover:bg-volt-deep",
}

const sizes = { sm: "size-9", md: "size-11", lg: "size-12" }

export function IconButton({
  label,
  variant = "ghost",
  size = "md",
  className,
  children,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full transition-[background-color,color,transform] duration-200 ease-gg active:scale-90 disabled:opacity-45 [&_svg]:size-5",
        variants[variant],
        sizes[size],
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
