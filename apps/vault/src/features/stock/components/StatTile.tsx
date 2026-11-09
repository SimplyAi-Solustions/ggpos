import * as React from "react"

import { cn } from "@/lib/cn"
import { Money } from "@/ui"

/** A summary tile: micro-label over one figure. */
export function StatTile({
  label,
  pence,
  count,
  note,
  accent,
}: {
  label: string
  pence?: number
  count?: number
  note?: React.ReactNode
  accent?: boolean
}) {
  return (
    <div
      className={cn(
        "glass flex min-w-0 flex-col gap-1 rounded-lg border border-line p-3.5 shadow-panel",
        accent && "border-volt/70 dark:[box-shadow:var(--glow-volt)]"
      )}
    >
      <p className="label-mono truncate text-fg-3">{label}</p>
      {pence !== undefined ? (
        <Money pence={pence} tween className="text-xl font-bold tracking-tight" />
      ) : (
        <span className="font-mono text-xl font-bold tnum">{(count ?? 0).toLocaleString("en-GB")}</span>
      )}
      {note && <p className="truncate text-xs text-fg-3">{note}</p>}
    </div>
  )
}
