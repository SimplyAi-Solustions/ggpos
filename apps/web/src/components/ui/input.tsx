import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"
import { cn } from "cn"

import { BarcodeGlyph, RingSpinner } from "@/components/ui/icons"

type InputSize = "default" | "scan"

type InputProps = Omit<React.ComponentProps<"input">, "size"> & {
  /** Thin line icon to the left of the text, 20px at 1.25 stroke, 12px gap. */
  leadingIcon?: React.ReactNode
  /** Right-aligned micro-text: "PRESS ENTER", "REQUIRED", "0 / 200". */
  trailingHint?: React.ReactNode
  /** `scan` is the biggest input on a counter screen: 28px Jost 300. */
  size?: InputSize
  /** Styles the underlined row rather than the `<input>` itself. */
  containerClassName?: string
}

/**
 * No box, no fill, no radius: one hairline under the row, which thickens to
 * 1.5px volt on focus and to 1.5px pop when the field is invalid. The caret
 * stays ink so the focused field reads as a place to type, not as a colour.
 */
function Input({
  className,
  containerClassName,
  type,
  size = "default",
  leadingIcon,
  trailingHint,
  ...props
}: InputProps) {
  const invalid = props["aria-invalid"] === true || props["aria-invalid"] === "true"

  return (
    <div
      data-slot="input-root"
      data-size={size}
      data-invalid={invalid || undefined}
      data-disabled={props.disabled || undefined}
      className={cn(
        "group/input relative flex w-full items-center gap-3",
        size === "scan" ? "min-h-16 pt-2 pb-3" : "min-h-10 pt-1 pb-3.5",
        "data-disabled:opacity-50",
        containerClassName
      )}
    >
      {leadingIcon ? (
        <span
          data-slot="input-leading-icon"
          aria-hidden="true"
          className="flex shrink-0 items-center text-foreground [&_svg]:size-5 [&_svg]:stroke-[1.25]"
        >
          {leadingIcon}
        </span>
      ) : null}

      <InputPrimitive
        type={type}
        data-slot="input"
        className={cn(
          "min-w-0 flex-1 border-0 bg-transparent p-0 pl-0 text-foreground caret-foreground outline-none",
          "placeholder:text-muted-foreground-2 disabled:cursor-not-allowed",
          size === "scan"
            ? "text-[24px] leading-[1.3] font-light sm:text-[28px] sm:leading-[1.25]"
            : "text-base leading-[1.5] font-normal",
          className
        )}
        {...props}
      />

      {trailingHint ? (
        <span
          data-slot="input-trailing-hint"
          className={cn(
            "shrink-0 pl-4 text-right font-mono text-[11px] leading-[1.4] font-bold tracking-[0.16em] text-muted-foreground-2 uppercase",
            "group-data-[invalid]/input:text-destructive",
            // A phone has no room for both a 28px placeholder and a hint.
            size === "scan" && "max-sm:hidden"
          )}
        >
          {trailingHint}
        </span>
      ) : null}

      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-hairline"
      />
      <span
        aria-hidden="true"
        data-slot="input-underline"
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 h-[1.5px] origin-left scale-x-0 bg-volt",
          "transition-transform duration-150 ease-gg",
          "group-focus-within/input:scale-x-100",
          "group-data-[invalid]/input:scale-x-100 group-data-[invalid]/input:bg-pop"
        )}
      />
    </div>
  )
}

export { Input, BarcodeGlyph, RingSpinner }
export type { InputProps, InputSize }
