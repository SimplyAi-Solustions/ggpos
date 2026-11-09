import { QrCode } from "lucide-react"
import type { Deal } from "@gg/shared/deal"

import { Money, Sheet } from "@/ui"

import { customerViewAvailable } from "../api"
import { lineMarket } from "../state"
import type { DealDraft } from "../types"

export interface CustomerViewSheetProps {
  open: boolean
  onClose: () => void
  draft: DealDraft
  deal: Deal
}

/**
 * "Show customer": a QR to a read-only live view of the offer.
 *
 * TODO(vault-api): the QR needs a share route that mints a revocable token
 * for one deal and a read-only fetch for it (no rates, no staff names, no
 * customer data). Until then this shows the view the customer would get, on
 * this screen, and no link is made.
 */
export function CustomerViewSheet({ open, onClose, draft, deal }: CustomerViewSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title="Show customer" description="What the customer sees. Read only.">
      <div className="flex flex-col gap-5">
        {!customerViewAvailable && (
          <div className="flex items-center gap-3 rounded-md border border-dashed border-line-2 p-3.5">
            <div className="flex size-14 shrink-0 items-center justify-center rounded-sm bg-panel-2 text-fg-3">
              <QrCode className="size-7" strokeWidth={1.25} aria-hidden />
            </div>
            <p className="text-sm text-fg-2">
              The live QR link needs the server's share route, which is not built yet. Turn the phone round to show this
              view instead.
            </p>
          </div>
        )}
        <CustomerDealView draft={draft} deal={deal} />
      </div>
    </Sheet>
  )
}

/** The customer's read-only view of an offer: items, market and both offers. */
export function CustomerDealView({ draft, deal }: { draft: DealDraft; deal: Deal }) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="label-mono text-pop-text">GG Entertainment</p>
        <p className="font-display text-3xl uppercase tracking-wide">Your offer</p>
      </div>
      <ul className="divide-y divide-line border-y border-line">
        {draft.lines.map((line, i) => (
          <li key={line.id} className="flex items-baseline justify-between gap-3 py-2.5">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">
                {line.qty > 1 && <span className="font-mono tnum">{line.qty} x </span>}
                {line.name}
              </span>
              {line.kind === "card" && (
                <span className="block truncate font-mono text-[11px] text-fg-3">
                  {line.condition} · {[line.setName, line.number].filter(Boolean).join(" ")}
                </span>
              )}
            </span>
            <Money pence={deal.lines[i]?.market ?? lineMarket(line) * line.qty} size="sm" tone="muted" />
          </li>
        ))}
      </ul>
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-fg-2">Market value</span>
        <Money pence={deal.market} tween />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-md border border-pop/50 p-3">
          <p className="label-mono text-fg-2">Trade credit</p>
          <Money pence={deal.trade} tween size="lg" tone="pop" />
        </div>
        <div className="rounded-md border border-line-2 p-3">
          <p className="label-mono text-fg-2">Cash</p>
          <Money pence={deal.cash} tween size="lg" tone="volt" />
        </div>
      </div>
    </div>
  )
}
