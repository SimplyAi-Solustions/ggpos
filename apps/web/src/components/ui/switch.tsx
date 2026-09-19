import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import { cn } from "cn"

/**
 * A small pill: ink when on, #e8e8e2 when off, paper thumb. Never volt -
 * yellow is reserved for focus, points, tiers, the logo and the done seal.
 */
function Switch({
  className,
  size = "default",
  ...props
}: SwitchPrimitive.Root.Props & { size?: "sm" | "default" }) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "group/switch relative inline-flex shrink-0 items-center rounded-full p-0.5 outline-none",
        "transition-colors duration-150 ease-gg",
        "data-[size=default]:h-6 data-[size=default]:w-11",
        "data-[size=sm]:h-5 data-[size=sm]:w-9",
        "data-checked:bg-primary data-unchecked:bg-surface-3",
        "data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full",
          // The thumb is always the opposite of the track it sits on.
          "data-checked:bg-primary-foreground data-unchecked:bg-gg-paper",
          "dark:data-unchecked:bg-muted-foreground",
          "shadow-[0_1px_2px_rgba(11,11,11,0.16)] transition-transform duration-150 ease-gg",
          "group-data-[size=default]/switch:size-5 group-data-[size=sm]/switch:size-4",
          "data-unchecked:translate-x-0",
          "group-data-[size=default]/switch:data-checked:translate-x-5",
          "group-data-[size=sm]/switch:data-checked:translate-x-4"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
