import * as React from "react"
import { Link } from "@tanstack/react-router"
import { AlertTriangle, ChevronRight, CircleCheck, Info, ShieldAlert } from "lucide-react"

import { cn } from "@/lib/cn"
import { Badge, Card, EmptyState, Money, PageHeader, Skeleton } from "@/ui"

import { errorText, useInventory } from "./api"
import { ItemThumb } from "./components/ItemThumb"
import { StockNav } from "./components/StockNav"
import { checkHealth, type HealthRule } from "./health/health"
import type { InventoryItem } from "./types"

const ICON = { alert: ShieldAlert, warn: AlertTriangle, info: Info }
const TONE = { alert: "pop", warn: "warn", info: "info" } as const

export function HealthPage() {
  const inventory = useInventory()
  const results = React.useMemo(() => checkHealth(inventory.data ?? []), [inventory.data])
  const flagged = new Set(results.flatMap((r) => r.items.map((i) => i.id))).size
  const total = inventory.data?.length ?? 0

  return (
    <section>
      <PageHeader eyebrow="Inventory" title="Health">
        What to reprice when the shop is quiet. Each alert opens its items.
      </PageHeader>
      <StockNav />

      {inventory.isPending ? (
        <div className="grid gap-3 md:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-40 rounded-lg" />
          ))}
        </div>
      ) : inventory.isError ? (
        <EmptyState title="Health did not load">{errorText(inventory.error, "Check the connection and try again.")}</EmptyState>
      ) : (
        <>
          <Card accent={flagged ? "pop" : "volt"} className="mb-4 flex items-center gap-4">
            <div
              className={cn(
                "flex size-14 shrink-0 items-center justify-center rounded-full [&_svg]:size-7",
                flagged ? "bg-pop text-on-pop" : "bg-volt text-on-volt"
              )}
            >
              {flagged ? <ShieldAlert aria-hidden /> : <CircleCheck aria-hidden />}
            </div>
            <div className="min-w-0">
              <p className="font-display text-3xl leading-none uppercase tracking-wide">
                {flagged} of {total}
              </p>
              <p className="text-sm text-fg-2">{flagged === 1 ? "line needs a look" : "lines need a look"}</p>
            </div>
          </Card>
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {results.map(({ rule, items }) => (
              <li key={rule.key}>
                <AlertCard rule={rule} items={items} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function AlertCard({ rule, items }: { rule: HealthRule; items: InventoryItem[] }) {
  const Icon = ICON[rule.severity]
  const clear = items.length === 0
  const body = (
    <>
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-md border [&_svg]:size-5",
            clear ? "border-line text-fg-3" : rule.severity === "alert" ? "border-pop/40 text-pop-text" : rule.severity === "warn" ? "border-warn/40 text-warn" : "border-info/40 text-info"
          )}
        >
          {clear ? <CircleCheck aria-hidden /> : <Icon aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">{rule.title}</h2>
            {clear ? (
              <Badge tone="ok">Clear</Badge>
            ) : (
              <Badge tone={TONE[rule.severity]} dot>
                {items.length} {items.length === 1 ? "line" : "lines"}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-sm text-fg-2">{rule.help}</p>
        </div>
      </div>
      {!clear && (
        <>
          <ul className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
            {items.slice(0, 3).map((item) => (
              <li key={item.id} className="flex items-center gap-2.5 text-sm">
                <ItemThumb item={item} className="w-7 rounded-[4px]" />
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <span className="flex shrink-0 items-baseline gap-1.5">
                  {item.price > 0 ? <Money pence={item.price} size="sm" className="font-semibold" /> : <span className="text-pop-text">No price</span>}
                  {item.cost > 0 && (
                    <span className="text-xs text-fg-3">
                      cost <Money pence={item.cost} className="text-xs text-fg-3" />
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <span className="mt-3 flex items-center justify-end gap-1 text-sm font-semibold">
            View {items.length === 1 ? "it" : `all ${items.length}`}
            <ChevronRight className="size-4" aria-hidden />
          </span>
        </>
      )}
    </>
  )
  if (clear) return <Card className="h-full opacity-80">{body}</Card>
  return (
    <Link to="/stock" search={{ alert: rule.key }} className="block h-full rounded-lg">
      <Card tilt className="h-full transition-colors hover:border-line-2">
        {body}
      </Card>
    </Link>
  )
}
