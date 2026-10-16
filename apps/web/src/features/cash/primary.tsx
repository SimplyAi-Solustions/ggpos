/**
 * A screen's one black block: in the flow from 900px, and docked in the
 * thumb zone above the tab bar on a phone, the way every counter screen
 * docks it (`app/counter-dock.ts`).
 */
import * as React from "react"
import { createPortal } from "react-dom"

import { useCounterDock } from "@/app/counter-dock"

/** A blocked block stays legible: ink on the switch grey, not half-faded. */
export const BLOCKED =
  "disabled:opacity-100 disabled:bg-surface-3 disabled:text-muted-foreground"

export function DockedPrimary({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  const dock = useCounterDock()
  return (
    <>
      <div className={className ?? "hidden min-[900px]:block"}>{children}</div>
      {dock
        ? createPortal(
            <div className="border-t border-hairline-soft bg-background px-5 py-3 min-[900px]:hidden [&_[data-slot=button]]:w-full">
              {children}
            </div>,
            dock
          )
        : null}
    </>
  )
}
