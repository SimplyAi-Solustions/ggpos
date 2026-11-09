import { AlertTriangle, Clock, RefreshCw } from "lucide-react"

import { cn } from "@/lib/cn"
import { Money } from "@/ui"

import { useEposItem } from "../api"
import { eposCopy, eposTime } from "../lib/epos-view"

/** The Epos Now slot on the item page: whether staff can sell it at the Epos till. */
export function EposStatus({ itemId, className }: { itemId: string; className?: string }) {
  const epos = useEposItem(itemId)
  const copy = eposCopy(epos.data, epos.isError)
  const Icon = copy.tone === "alert" ? AlertTriangle : copy.tone === "wait" ? Clock : RefreshCw
  const sold = epos.data?.sold_on_till
  return (
    <div
      data-slot="epos-status"
      data-state={epos.data?.status ?? "loading"}
      className={cn(
        "flex items-center gap-3 rounded-md border px-3.5 py-3",
        copy.tone === "alert" ? "border-pop/50" : "border-dashed border-line-2",
        className
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-full",
          copy.tone === "ok" && "bg-ok/15 text-ok",
          copy.tone === "wait" && "bg-warn/15 text-warn",
          copy.tone === "alert" && "bg-pop/15 text-pop-text",
          copy.tone === "off" && "bg-line text-fg-3"
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{copy.title}</p>
        <p className="text-xs text-fg-3">{copy.line}</p>
        {sold && (
          <p className="text-xs text-fg-3">
            Sold on the Epos till for <Money pence={sold.unit_price} className="text-xs text-fg-3" />
            {sold.sold_at ? `, ${eposTime(sold.sold_at)}` : ""}
          </p>
        )}
      </div>
    </div>
  )
}
