import { Disc3, Gamepad2, Layers, Package, ShieldCheck } from "lucide-react"

import { CardArt, type CardArtProps } from "@/ui"

import { isCard } from "../lib/item-view"
import type { InventoryItem } from "../types"

const ICONS = { single: Layers, graded: ShieldCheck, sealed: Package, retro: Gamepad2, accessory: Disc3, other: Package }

/**
 * A stock item drawn with CardArt. Cards get their finish; sealed, retro
 * and the rest are drawn flat, with the kind's icon when there is no photo.
 */
export function ItemArt({
  item,
  ...rest
}: { item: Pick<InventoryItem, "image" | "kind" | "title" | "finish" | "number"> } & Omit<
  CardArtProps,
  "src" | "alt" | "finish" | "fallback"
>) {
  const Icon = ICONS[item.kind] ?? Package
  return (
    <CardArt
      src={item.image}
      alt={item.number ? `${item.title} ${item.number}` : item.title}
      finish={isCard(item) ? item.finish : "normal"}
      fallback={<Icon aria-hidden />}
      {...rest}
    />
  )
}
