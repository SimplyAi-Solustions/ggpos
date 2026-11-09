import * as React from "react"
import { Link } from "@tanstack/react-router"
import { ChevronLeft } from "lucide-react"
import { formatGBP } from "@gg/shared/money"

import { Badge, Money, PageHeader } from "@/ui"

import { formatPct } from "./format"
import { priceDraft } from "./state"
import type { DealDraft } from "./types"

/** A completed deal: the record of what was paid and how it was worked out. Read only. */
export function CompletedDeal({ deal: draft }: { deal: DealDraft }) {
  const deal = React.useMemo(() => priceDraft(draft), [draft])
  const done = draft.completed
  const payout = done?.payout
  const at = done ? new Date(done.at) : null

  return (
    <div className="flex flex-col gap-5">
      <Link to="/deals" className="-ml-2 flex h-9 w-fit items-center gap-0.5 rounded-sm px-2 text-sm font-medium text-fg-2 hover:text-fg">
        <ChevronLeft className="size-4" aria-hidden />
        Deals
      </Link>
      <PageHeader
        eyebrow={at ? `Completed ${at.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}` : "Completed"}
        title={draft.name}
      />

      {done && payout && (
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line">
          <div className="bg-panel px-4 py-3 dark:bg-bg-2">
            <p className="label-mono text-fg-2">Trade credit</p>
            <Money pence={payout.credit} size="lg" tone={payout.credit ? "pop" : "muted"} />
          </div>
          <div className="bg-panel px-4 py-3 dark:bg-bg-2">
            <p className="label-mono text-fg-2">Cash</p>
            <Money pence={payout.cash} size="lg" tone={payout.cash ? "volt" : "muted"} />
          </div>
        </div>
      )}

      {done && (
        <dl className="flex flex-col divide-y divide-line border-y border-line text-sm">
          <Row label="Market value" value={formatGBP(done.market)} />
          <Row label="Sweep rates" value={`${formatPct(draft.rates.tradePct)} trade, ${formatPct(draft.rates.cashPct)} cash`} />
          <Row
            label="Trade total"
            value={formatGBP(done.trade)}
            struck={done.tradeOverridden ? formatGBP(done.calculatedTrade) : undefined}
          />
          <Row
            label="Cash total"
            value={formatGBP(done.cash)}
            struck={done.cashOverridden ? formatGBP(done.calculatedCash) : undefined}
          />
          <Row label="Value captured" value={formatGBP(done.market - done.payout.cash - done.payout.credit)} />
        </dl>
      )}

      <ul className="divide-y divide-line">
        {draft.lines.map((line, i) => (
          <li key={line.id} className="flex items-baseline justify-between gap-3 py-2.5">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">
                {line.qty > 1 && <span className="font-mono tnum">{line.qty} x </span>}
                {line.name}
              </span>
              <span className="block font-mono text-[11px] text-fg-3 tnum">
                {line.kind === "card" ? `${line.condition} · ` : ""}
                {formatPct(deal.lines[i]?.tradePct)} trade, {formatPct(deal.lines[i]?.cashPct)} cash
                {(line.tradePct !== undefined || line.cashPct !== undefined) && " (own rate)"}
              </span>
            </span>
            <span className="shrink-0 text-right font-mono text-xs tnum">
              <span className="block text-pop-text">{formatGBP(deal.lines[i]?.trade ?? 0)}</span>
              <span className="block text-fg-2">{formatGBP(deal.lines[i]?.cash ?? 0)}</span>
            </span>
          </li>
        ))}
      </ul>

      {draft.note && (
        <div>
          <p className="label-mono mb-1 text-fg-2">Note</p>
          <p className="text-sm whitespace-pre-wrap">{draft.note}</p>
        </div>
      )}
      {(done?.tradeOverridden || done?.cashOverridden) && (
        <Badge tone="pop" className="self-start">
          Final figure overridden
        </Badge>
      )}
    </div>
  )
}

function Row({ label, value, struck }: { label: string; value: string; struck?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2.5">
      <dt className="text-fg-2">{label}</dt>
      <dd className="font-mono tnum">
        {struck && <s className="mr-2 text-fg-3">{struck}</s>}
        {value}
      </dd>
    </div>
  )
}
