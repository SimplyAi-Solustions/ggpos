import * as React from "react"
import { Disc3, Gamepad2, Layers, Package, ShieldCheck } from "lucide-react"

import { cn } from "@/lib/cn"

import type { InventoryItem } from "../types"

const ICONS = { single: Layers, graded: ShieldCheck, sealed: Package, retro: Gamepad2, accessory: Disc3, other: Package }

/** A card-shaped thumbnail, or the kind's icon when there is no picture. */
export function ItemThumb({ item, className }: { item: Pick<InventoryItem, "image" | "kind" | "title">; className?: string }) {
  const [failed, setFailed] = React.useState(false)
  const Icon = ICONS[item.kind] ?? Package
  return (
    <div
      className={cn(
        "relative flex aspect-[5/7] w-11 shrink-0 items-center justify-center overflow-hidden rounded-[6px] border border-line bg-panel-2 text-fg-3",
        className
      )}
    >
      {item.image && !failed ? (
        <img src={item.image} alt="" loading="lazy" className="size-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <Icon className="size-5" aria-hidden />
      )}
    </div>
  )
}
