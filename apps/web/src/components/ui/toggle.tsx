import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { cn } from "cn"

/**
 * A bare icon toggle. For labelled options, reach for `Chip` and `ChipGroup`,
 * which carry the brand's hairline pill.
 */
function Toggle({ className, ...props }: TogglePrimitive.Props) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center rounded-[var(--radius)] text-foreground outline-none",
        "transition-colors duration-150 ease-gg hover:bg-secondary",
        "aria-pressed:bg-primary aria-pressed:text-primary-foreground",
        "data-disabled:pointer-events-none data-disabled:opacity-50",
        "[&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:stroke-[1.25]",
        className
      )}
      {...props}
    />
  )
}

export { Toggle }
