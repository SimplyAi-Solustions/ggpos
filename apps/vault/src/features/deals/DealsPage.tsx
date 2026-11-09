import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { ChevronRight, Handshake, Plus } from "lucide-react"

import { Badge, Button, buttonClasses, EmptyState, Money, PageHeader, Segmented, Skeleton } from "@/ui"

import { createDeal, explain, listDeals } from "./api"
import type { AddFromScan } from "./DealBuilder"
import { formatUpdated } from "./format"
import { itemCount, priceDraft } from "./state"
import type { DealDraft } from "./types"

type Tab = "open" | "completed" | "all"

const TABS: ReadonlyArray<{ value: Tab; label: string }> = [
  { value: "open", label: "Open" },
  { value: "completed", label: "Completed" },
  { value: "all", label: "All" },
]

export function DealsPage({ addFromScan }: { addFromScan?: AddFromScan } = {}) {
  if (addFromScan?.add) return <NewDealFromScan addFromScan={addFromScan} />
  return <DealsList />
}

/**
 * Scan sent cards with no deal open (or the batch tray's "Add all to deal"):
 * a new draft takes them. The builder adds the cards and clears the params.
 */
function NewDealFromScan({ addFromScan }: { addFromScan: AddFromScan }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [error, setError] = React.useState<string | null>(null)
  const [attempt, setAttempt] = React.useState(0)
  const started = React.useRef(-1)

  React.useEffect(() => {
    if (started.current === attempt) return
    started.current = attempt
    createDeal()
      .then((draft) => {
        queryClient.setQueryData(["deals", "one", draft.id], draft)
        void queryClient.invalidateQueries({ queryKey: ["deals", "list"] })
        void navigate({
          to: "/deals/$id",
          params: { id: draft.id },
          search: { add: addFromScan.add, condition: addFromScan.condition },
          replace: true,
        })
      })
      .catch((err) => setError(explain(err, "The new deal was not created. Try again.")))
  }, [attempt, addFromScan, navigate, queryClient])

  if (error) {
    return (
      <EmptyState
        icon={<Handshake aria-hidden />}
        title="No new deal"
        action={
          <div className="flex gap-2">
            <Link to="/deals" search={{}} className={buttonClasses("secondary")}>
              Back to deals
            </Link>
            <Button
              onClick={() => {
                setError(null)
                setAttempt((n) => n + 1)
              }}
            >
              Try again
            </Button>
          </div>
        }
      >
        {error}
      </EmptyState>
    )
  }
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Starting a new deal for the scanned cards">
      <Skeleton className="h-10 w-2/3" />
      <Skeleton className="h-20" />
    </div>
  )
}

function DealsList() {
  const [tab, setTab] = React.useState<Tab>("open")
  const deals = useQuery({ queryKey: ["deals", "list"], queryFn: listDeals, staleTime: 0, refetchOnMount: "always" })

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
        ) : deals.isError ? (
          <EmptyState
            icon={<Handshake aria-hidden />}
            title="Deals did not load"
            action={<Button onClick={() => void deals.refetch()}>Try again</Button>}
          >
            {explain(deals.error, "The deals list did not load. Try again.")}
          </EmptyState>
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
            {draft.seller ? `${draft.seller.name} · ` : ""}
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
