import * as React from "react"
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog"
import { cn } from "cn"
import { XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({ ...props }: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetPortal({ ...props }: SheetPrimitive.Portal.Props) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetOverlay({ className, ...props }: SheetPrimitive.Backdrop.Props) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-gg-ink/25 transition-opacity duration-200 ease-gg",
        "data-ending-style:opacity-0 data-starting-style:opacity-0",
        className
      )}
      {...props}
    />
  )
}

/**
 * A paper panel with a hairline edge and one soft shadow. On phones every
 * sheet docks to the bottom in the thumb zone, whatever `side` says.
 */
function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  ...props
}: SheetPrimitive.Popup.Props & {
  side?: "top" | "right" | "bottom" | "left"
  showCloseButton?: boolean
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          "fixed z-50 flex flex-col border border-hairline bg-popover text-popover-foreground shadow-panel",
          "rounded-t-[var(--radius)] transition-[opacity,transform] duration-200 ease-gg",
          "data-ending-style:opacity-0 data-starting-style:opacity-0",
          // phones: always a bottom sheet
          "inset-x-0 bottom-0 max-h-[85svh] w-full",
          "data-ending-style:translate-y-6 data-starting-style:translate-y-6",
          // from 640px: honour the requested side
          "sm:rounded-[var(--radius)]",
          "sm:data-[side=right]:inset-y-0 sm:data-[side=right]:right-0 sm:data-[side=right]:left-auto sm:data-[side=right]:h-full sm:data-[side=right]:max-h-none sm:data-[side=right]:w-full sm:data-[side=right]:max-w-md",
          "sm:data-[side=left]:inset-y-0 sm:data-[side=left]:right-auto sm:data-[side=left]:left-0 sm:data-[side=left]:h-full sm:data-[side=left]:max-h-none sm:data-[side=left]:w-full sm:data-[side=left]:max-w-md",
          "sm:data-[side=top]:inset-x-0 sm:data-[side=top]:top-0 sm:data-[side=top]:bottom-auto sm:data-[side=top]:h-auto",
          "sm:data-[side=right]:data-ending-style:translate-x-6 sm:data-[side=right]:data-ending-style:translate-y-0",
          "sm:data-[side=right]:data-starting-style:translate-x-6 sm:data-[side=right]:data-starting-style:translate-y-0",
          "sm:data-[side=left]:data-ending-style:-translate-x-6 sm:data-[side=left]:data-ending-style:translate-y-0",
          "sm:data-[side=left]:data-starting-style:-translate-x-6 sm:data-[side=left]:data-starting-style:translate-y-0",
          "sm:data-[side=top]:data-ending-style:-translate-y-6 sm:data-[side=top]:data-starting-style:-translate-y-6",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            render={<Button variant="ghost-icon" className="absolute top-4 right-4" />}
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        ) : null}
      </SheetPrimitive.Popup>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-2 px-6 pt-6 pb-4", className)}
      {...props}
    />
  )
}

function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-body"
      className={cn("flex-1 overflow-y-auto px-6 pb-6", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn(
        "mt-auto flex flex-wrap items-center gap-6 px-6 pt-4 pb-6",
        className
      )}
      {...props}
    />
  )
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn(
        "font-mono text-[11px] font-bold tracking-[0.16em] text-foreground uppercase",
        className
      )}
      {...props}
    />
  )
}

function SheetDescription({ className, ...props }: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-[15px] leading-[1.5] text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
