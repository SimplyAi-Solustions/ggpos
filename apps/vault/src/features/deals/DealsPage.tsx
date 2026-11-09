import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ChevronRight, Handshake, Plus } from "lucide-react"

import { Badge, buttonClasses, EmptyState, Money, PageHeader, Segmented, Skeleton } from "@/ui"

import { listDeals } from "./api"
import { formatUpdated } from "./format"
import { itemCount, priceDraft } from "./state"
import type { DealDraft } from "./types"

type Tab = "open" | "completed" | "all"

const TABS: ReadonlyArray<{ value: Tab; label: string }> = [
  { value: "open", label: "Open" },
  { value: "completed", label: "Completed" },
  { value: "all", label: "All" },
]

export function DealsPage() {
  const [tab, setTab] = React.useState<Tab>("open")
  const deals = useQuery({ queryKey: ["deals", "list"], queryFn: listDeals, staleTime: 0 })

  const shown = (deals.data ?? []).filter((d) => tab === "all" || (tab === "open" ? d.status === "open" : d.status === "completed"))
  const openCount = (deals.data ?? []).filter((d) => d.status === "open").length

  return (
    <div className="flex flex-col">
      <PageHeader
        eyebrow="Buy-ins"
        title="Deals"
        actions={
          <Link to="/deals/new" className={buttonClasses("primary", "md")}>
            <Plus className="size-5" aria-hidden />
            New deal
          </Link>
        }
      />

      <Segmented<Tab>
        label="Show deals"
        block
        value={tab}
        onChange={setTab}
        options={TABS.map((t) => (t.value === "open" && openCount ? { ...t, label: `Open ${openCount}` } : t))}
      />

      <div className="mt-4">
        {deals.isPending ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
        ) : shown.length === 0 ? (
          <EmptyState
            icon={<Handshake aria-hidden />}
            title={tab === "completed" ? "None completed" : "No deals"}
            action={
              tab !== "completed" && (
                <Link to="/deals/new" className={buttonClasses("primary")}>
                  <Plus className="size-5" aria-hidden />
                  New deal
                </Link>
              )
            }
          >
            {tab === "completed" ? "Completed deals show here." : "Start one when a customer brings cards in."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-panel shadow-panel dark:bg-panel-2">
            {shown.map((deal) => (
              <DealRow key={deal.id} deal={deal} showStatus={tab === "all"} />
            ))}
          </ul>
        )}
      </div>
      <p className="mt-4 text-center text-xs text-fg-3">Drafts are saved on this device until the server keeps them.</p>
    </div>
  )
}

function DealRow({ deal: draft, showStatus }: { deal: DealDraft; showStatus: boolean }) {
  const deal = priceDraft(draft)
  const done = draft.completed
  const items = itemCount(draft.lines)
  return (
    <li>
      <Link
        to="/deals/$id"
        params={{ id: draft.id }}
        className="flex items-center gap-3 px-4 py-3.5 transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-line/50"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate font-semibold">{draft.name}</p>
          </div>
          {(done || showStatus) && (
            <Badge tone={done ? "ok" : "warn"} dot className="my-1">
              {done ? `Paid ${payoutLabel(done.payout.type)}` : "Open"}
            </Badge>
          )}
          <p className="font-mono text-xs text-fg-3 tnum">
            {items} {items === 1 ? "item" : "items"} · {formatUpdated(draft.updatedAt)}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end">
          <span className="flex items-baseline gap-1.5">
            <span className="label-mono text-fg-3">Trade</span>
            <Money pence={done ? done.trade : deal.trade} tone="pop" size="sm" className="font-bold" />
          </span>
          <span className="flex items-baseline gap-1.5">
            <span className="label-mono text-fg-3">Cash</span>
            <Money pence={done ? done.cash : deal.cash} tone="volt" size="sm" className="font-bold" />
          </span>
        </div>
        <ChevronRight className="size-4 shrink-0 text-fg-3" aria-hidden />
      </Link>
    </li>
  )
}

function payoutLabel(type: "cash" | "credit" | "mixed"): string {
  return type === "mixed" ? "split" : type === "cash" ? "cash" : "credit"
}
