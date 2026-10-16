import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cn } from "cn"

/** Tracked micro-text with a 2px volt underline on the active tab. */
function Tabs({ className, orientation = "horizontal", ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn("group/tabs flex gap-6 data-horizontal:flex-col", className)}
      {...props}
    />
  )
}

function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "inline-flex w-fit items-center gap-8 border-b border-hairline-soft",
        "group-data-vertical/tabs:flex-col group-data-vertical/tabs:items-start group-data-vertical/tabs:gap-4 group-data-vertical/tabs:border-0",
        className
      )}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex items-center gap-2 pb-3 font-mono text-[11px] font-bold tracking-[0.16em] whitespace-nowrap uppercase",
        "text-muted-foreground-2 transition-colors duration-150 ease-gg outline-none",
        "hover:text-foreground data-active:text-foreground",
        "data-disabled:pointer-events-none data-disabled:opacity-50",
        "after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:origin-left after:scale-x-0 after:bg-volt",
        "after:transition-transform after:duration-150 after:ease-gg data-active:after:scale-x-100",
        "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.25]",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
