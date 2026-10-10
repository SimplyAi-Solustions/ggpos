import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { cn } from "cn"

/**
 * The avatar menu and any other short list of actions hung off a control.
 * Same paper panel as the Select popup: hairline edge, 4px radius, one soft
 * shadow. No icons, no shortcuts column, no submenus.
 */

const Menu = MenuPrimitive.Root
const MenuTrigger = MenuPrimitive.Trigger

function MenuContent({
  className,
  children,
  side = "bottom",
  sideOffset = 8,
  align = "end",
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, "side" | "sideOffset" | "align">) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        className="isolate z-50"
      >
        <MenuPrimitive.Popup
          data-slot="menu-content"
          className={cn(
            "min-w-52 origin-(--transform-origin) overflow-hidden p-1",
            "rounded-[var(--radius)] border border-hairline bg-popover text-popover-foreground shadow-panel",
            "transition-[opacity,transform] duration-150 ease-gg",
            "data-ending-style:translate-y-[-2px] data-ending-style:opacity-0",
            "data-starting-style:translate-y-[-2px] data-starting-style:opacity-0",
            className
          )}
          {...props}
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

function MenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return (
    <MenuPrimitive.Item
      data-slot="menu-item"
      className={cn(
        "flex w-full cursor-default items-center justify-between gap-4 rounded-[var(--radius)] px-3 py-2",
        "text-[15px] leading-[1.4] text-foreground outline-none select-none",
        "data-highlighted:bg-secondary data-disabled:pointer-events-none data-disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

function MenuLabel({ className, ...props }: MenuPrimitive.GroupLabel.Props) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="menu-label"
      className={cn(
        "px-3 pt-2.5 pb-1.5 font-mono text-[11px] font-bold tracking-[0.16em] text-muted-foreground uppercase",
        className
      )}
      {...props}
    />
  )
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="menu-separator"
      className={cn("pointer-events-none my-1 h-px bg-hairline-soft", className)}
      {...props}
    />
  )
}

export {
  Menu,
  MenuTrigger,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuPrimitive,
}
