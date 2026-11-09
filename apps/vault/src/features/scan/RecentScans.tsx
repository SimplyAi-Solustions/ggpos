import { Link } from "@tanstack/react-router"
import { History, X } from "lucide-react"

import { Money } from "@/ui"
import { CardImage } from "@/features/cards/CardImage"
import { numberLabel } from "@/features/cards/format"

import type { RecentScan } from "./history"

/** The last twenty cards scanned on this device, so one can be reopened without the photo. */
export function RecentScans({ scans, onClear, className }: { scans: readonly RecentScan[]; onClear: () => void; className?: string }) {
  if (!scans.length) return null
  return (
    <section aria-labelledby="recent-heading" className={className}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 id="recent-heading" className="label-mono flex items-center gap-1.5 text-fg-2">
          <History className="size-3.5" aria-hidden />
          Recent scans
        </h2>
        <button type="button" onClick={onClear} className="inline-flex h-8 items-center gap-1 rounded-sm px-2 text-xs font-medium text-fg-3 hover:bg-line hover:text-fg">
          <X className="size-3.5" aria-hidden />
          Clear
        </button>
      </div>
      <ul className="-mx-4 flex snap-x gap-2.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:mx-0 md:px-0">
        {scans.map((scan) => (
          <li key={scan.id} className="w-[132px] shrink-0 snap-start">
            <Link to="/cards/$id" params={{ id: scan.id }} className="flex h-full flex-col gap-2 rounded-lg border border-line bg-panel p-2 shadow-panel transition-colors hover:border-line-2">
              <span className="flex justify-center">
                <CardImage src={scan.image_small} alt="" width={64} />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-xs font-semibold text-fg">{scan.name}</span>
                <span className="truncate text-[11px] text-fg-3">
                  {scan.set_name} · <span className="font-mono tnum">{numberLabel(scan)}</span>
                </span>
                <span className="mt-1">{scan.nm_pence != null ? <Money pence={scan.nm_pence} size="sm" className="font-bold" /> : <span className="text-[11px] text-fg-3">No price</span>}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
