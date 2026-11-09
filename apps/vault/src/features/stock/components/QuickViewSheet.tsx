import type * as React from "react"

import { ArrowRight, MapPin } from "lucide-react"
import { displayCode } from "@gg/shared/sku"

import { cn } from "@/lib/cn"
import { Badge, Button, Money, Sheet } from "@/ui"

import { marginPct } from "../lib/inventory"
import { marginTone, marketLabel, setLine, variantTag } from "../lib/item-view"
import type { InventoryItem } from "../types"
import { ItemArt } from "./ItemArt"

/**
 * The quick look from an inventory row or a binder pocket: the card, its
 * figures, and the way to the full item page.
 */
export function QuickViewSheet({
  item,
  open,
  onClose,
  onOpenItem,
}: {
  item: InventoryItem | null
  open: boolean
  onClose: () => void
  onOpenItem: (item: InventoryItem) => void
}) {
  if (!item) return null
  const margin = marginPct(item.price, item.cost)
  const tag = variantTag(item)
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={item.title}
      description={[displayCode(item.sku), setLine(item)].filter(Boolean).join("  ·  ")}
      footer={
        <Button block size="lg" iconRight={<ArrowRight className="size-5" aria-hidden />} onClick={() => onOpenItem(item)}>
          Open item
        </Button>
      }
    >
      <div className="flex flex-col gap-4 pt-1">
        <div className="relative flex justify-center py-3">
          <div aria-hidden className="pointer-events-none absolute inset-x-6 top-4 bottom-0 rounded-full bg-volt/10 blur-3xl dark:bg-volt/5" />
          <ItemArt item={item} className="w-[52%] max-w-[210px]" gyro priority />
        </div>

        <div className="flex flex-wrap justify-center gap-1.5">
          {tag && <Badge tone="violet">{tag}</Badge>}
          {item.condition && item.kind === "single" && <Badge>{item.condition}</Badge>}
          {item.qty > 1 && <Badge tone="info">Qty {item.qty}</Badge>}
          <Badge tone={item.location_name ? "neutral" : "warn"}>
            <MapPin className="size-3" aria-hidden />
            {item.location_name || "Not shelved"}
          </Badge>
        </div>

        <dl className="grid grid-cols-2 gap-2">
          <Figure label="Sticker" accent>
            {item.price > 0 ? <Money pence={item.price} size="lg" /> : <span className="font-semibold text-pop-text">No price</span>}
          </Figure>
          <Figure label={marketLabel(item)}>
            {item.market !== null ? <Money pence={item.market} size="lg" /> : <span className="text-fg-3">None on file</span>}
          </Figure>
          <Figure label="Cost">
            {item.cost > 0 ? <Money pence={item.cost} className="text-lg font-bold" /> : <span className="text-fg-3">None</span>}
          </Figure>
          <Figure label="Margin">
            {margin !== null ? (
              <Badge tone={marginTone(margin)} className="h-7 px-3 text-xs">
                {margin}%
              </Badge>
            ) : (
              <span className="text-fg-3">None</span>
            )}
          </Figure>
        </dl>
      </div>
    </Sheet>
  )
}

function Figure({ label, accent, children }: { label: string; accent?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-md border border-line bg-panel-2 px-3.5 py-3",
        accent && "border-volt/70 dark:[box-shadow:var(--glow-volt)]"
      )}
    >
      <dt className="label-mono truncate text-[10px] text-fg-3">{label}</dt>
      <dd className="min-h-8 font-mono tnum">{children}</dd>
    </div>
  )
}
