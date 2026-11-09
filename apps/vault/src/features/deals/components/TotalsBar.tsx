import { ArrowRight } from "lucide-react"
import type { Deal } from "@gg/shared/deal"

import { Button, Money } from "@/ui"

export interface TotalsBarProps {
  deal: Deal
  items: number
  onReview: () => void
  canReview: boolean
}

/** Sticky at the foot of the builder, above the tab bar: market, trade and cash, and Review. */
export function TotalsBar({ deal, items, onReview, canReview }: TotalsBarProps) {
  return (
    <div className="sticky bottom-[calc(var(--tabbar-h)+var(--safe-bottom)+10px)] z-20 mt-4 md:bottom-4">
      <div className="glass rounded-lg border border-line-2 px-3.5 pt-2.5 pb-3 shadow-sheet">
        <dl className="grid grid-cols-2 gap-3">
          <div className="min-w-0">
            <dt className="label-mono flex items-center gap-1.5 text-fg-2">
              <span className="size-1.5 rounded-full bg-pop" aria-hidden />
              Trade
            </dt>
            <dd>
              <Money pence={deal.trade} tween tone="pop" size="lg" data-testid="total-trade" />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="label-mono flex items-center gap-1.5 text-fg-2">
              <span className="size-1.5 rounded-full bg-volt" aria-hidden />
              Cash
            </dt>
            <dd>
              <Money pence={deal.cash} tween tone="volt" size="lg" data-testid="total-cash" />
            </dd>
          </div>
        </dl>
        <div className="mt-2 flex items-center justify-between gap-3 border-t border-line pt-2.5">
          <div className="min-w-0">
            <p className="label-mono text-fg-3">
              {items} {items === 1 ? "item" : "items"} · Market
            </p>
            <Money pence={deal.market} tween size="sm" tone="muted" />
          </div>
          <Button size="sm" onClick={onReview} disabled={!canReview} iconRight={<ArrowRight className="size-4" aria-hidden />}>
            Review deal
          </Button>
        </div>
      </div>
    </div>
  )
}
