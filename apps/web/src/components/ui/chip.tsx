import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group"
import { cn } from "cn"

/**
 * Condition, finish, rarity: a hairline pill that fills ink when chosen.
 * Never yellow - volt is reserved for focus, points, tiers and the seal.
 */
function Chip({ className, ...props }: TogglePrimitive.Props) {
  return (
    <TogglePrimitive
      data-slot="chip"
      className={cn(
        // The pill stays 32px, which is the shape the reference screens
        // draw; on a phone it carries a 48px hit area through a pseudo
        // element instead, so the thumb target clears the bar without the
        // chips growing into each other.
        "relative inline-flex h-8 shrink-0 items-center justify-center rounded-full border border-hairline px-4",
        "max-sm:after:absolute max-sm:after:inset-x-0 max-sm:after:top-1/2 max-sm:after:h-12 max-sm:after:-translate-y-1/2 max-sm:after:content-['']",
        "font-sans text-[13px] leading-none font-medium text-foreground whitespace-nowrap",
        "transition-[background-color,color,border-color] duration-150 ease-gg outline-none",
        "hover:border-foreground",
        "aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground",
        "data-disabled:pointer-events-none data-disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

type ChipGroupProps<Value extends string = string> = Omit<
  ToggleGroupPrimitive.Props<Value>,
  "multiple"
> & {
  /** `false` (the default) keeps one chip pressed; `true` allows several. */
  multiple?: boolean
  /** Chip groups have no visible label of their own, so name them. */
  "aria-label"?: string
}

/**
 * Arrow keys move between chips, space and enter toggle, the group holds the
 * value. Single select by default, `multiple` for filters.
 */
function ChipGroup<Value extends string = string>({
  className,
  multiple = false,
  ...props
}: ChipGroupProps<Value>) {
  return (
    <ToggleGroupPrimitive
      data-slot="chip-group"
      multiple={multiple}
      className={cn("flex flex-wrap items-center gap-2", className)}
      {...(props as ToggleGroupPrimitive.Props<Value>)}
    />
  )
}

export { Chip, ChipGroup }
export type { ChipGroupProps }
