import { RefreshCw } from "lucide-react"

import { cn } from "@/lib/cn"

/**
 * The Epos Now slot on the item page. The sync is being built separately;
 * until it stamps `epos_product_id` on an item this says so plainly. Once
 * the field is there, this shows the link without any change here.
 */
export function EposStatus({ productId, className }: { productId?: string | null; className?: string }) {
  const linked = Boolean(productId)
  return (
    <div
      data-slot="epos-status"
      className={cn("flex items-center gap-3 rounded-md border border-dashed border-line-2 px-3.5 py-3", className)}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-full",
          linked ? "bg-ok/15 text-ok" : "bg-line text-fg-3"
        )}
      >
        <RefreshCw className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{linked ? "Epos Now: linked" : "Epos Now: not synced yet"}</p>
        <p className="text-xs text-fg-3">
          {linked ? `Product ${productId}` : "This item shows here once the Epos Now sync is switched on."}
        </p>
      </div>
    </div>
  )
}
