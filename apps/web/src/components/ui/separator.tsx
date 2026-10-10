import { Separator as SeparatorPrimitive } from "@base-ui/react/separator"
import { cn } from "cn"

/**
 * Sections are divided by whitespace. A Separator is for the rare place that
 * needs a real edge, and it is always the faintest hairline.
 */
function Separator({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 bg-hairline-faint data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
