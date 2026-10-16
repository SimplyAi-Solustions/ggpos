/**
 * The Trade-in panel (docs/api-contract-epos.md, section 7; DESIGN.md,
 * section 10): a part-exchange taken in the same ticket. It opens in the
 * catalogue pane the way Pay opens the tender pane, and the ticket stays
 * beside it, its trade group and its total moving as each line is priced.
 *
 * The lines are the buy-in wizard's own parts (`TradeLines.tsx`): the card
 * search, condition and finish chips, the retro fields, the bulk lot, the
 * side-by-side sources and the override sheet. Each line shows the credit
 * offer, which is what part-exchange pays, with the cash offer as the hint
 * under it.
 */
import * as React from "react"
import { displayCode, formatGBP } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Hint, MicroLabel } from "@/components/ui/micro-label"
import { TradeLineEntry, TradeLineList } from "@/features/tradein/TradeLines"
import type { TradeLine } from "@/features/tradein/machine"
import type { TradeFigures, PricingContext } from "@/features/till/exchange"
import type { TicketTrade } from "@/features/till/ticket"

export interface TradeInPanelProps {
  trade: TicketTrade
  /** The customer's code, under their name. */
  customerCode: string
  pricing: PricingContext
  figures: TradeFigures
  rulesMissing: boolean
  saveError: string | null
  onAdd: (line: TradeLine) => void
  onUpdate: (key: string, patch: Partial<TradeLine>) => void
  onRemoveLine: (key: string) => void
  /** Back to the tiles; the trade stays on the ticket. */
  onClose: () => void
  /** Takes the whole trade-in off the ticket. */
  onRemove: () => void
}

export function TradeInPanel({
  trade,
  customerCode,
  pricing,
  figures,
  rulesMissing,
  saveError,
  onAdd,
  onUpdate,
  onRemoveLine,
  onClose,
  onRemove,
}: TradeInPanelProps) {
  // Two presses to take a whole trade-in off, as for clearing a ticket.
  const [asking, setAsking] = React.useState(false)
  const empty = trade.lines.length === 0

  return (
    <section
      aria-label="Trade-in"
      data-testid="till-trade-panel"
      className="flex min-h-full flex-col px-5 pt-6 pb-10 sm:px-8"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <MicroLabel tone="ink">Trade-in</MicroLabel>
          <span className="truncate text-[20px] leading-[1.3] font-medium text-foreground">
            {trade.customerName}
          </span>
          {customerCode ? (
            <span className="tnum font-mono text-[13px] text-muted-foreground-2">
              {displayCode(customerCode)}
            </span>
          ) : null}
        </div>
        <Button variant="text" className="min-h-14" data-testid="till-trade-close" onClick={onClose}>
          Back to the items
        </Button>
      </div>
      <p className="mt-4 max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
        Valued at credit rates. What it is worth comes off the ticket.
      </p>

      <div className="mt-10">
        <TradeLineEntry onAdd={onAdd} />
      </div>

      {rulesMissing ? (
        <p className="mt-8 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground">
          No offer bands are set up yet, so nothing prices itself. Enter each offer with
          Override, or add the bands in Settings.
        </p>
      ) : null}

      <TradeLineList
        lines={trade.lines}
        rules={pricing.rules}
        settings={pricing.settings}
        multipliers={pricing.multipliers}
        offers="credit"
        onUpdate={onUpdate}
        onRemove={onRemoveLine}
        className="mt-10"
        label="Lines on this trade-in"
      />

      {empty ? (
        <p className="mt-10 max-w-[56ch] text-[16px] leading-[1.5] text-muted-foreground">
          Nothing to trade yet. Search a card, or add a retro, sealed or bulk line.
        </p>
      ) : (
        <dl className="mt-6 flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
          <div>
            <dt>
              <MicroLabel className="mb-2">Comes off the ticket</MicroLabel>
            </dt>
            <dd
              data-testid="till-trade-value"
              className="tnum text-[20px] leading-none font-medium text-foreground"
            >
              {formatGBP(figures.credit)}
            </dd>
          </div>
          <div className="flex items-baseline gap-2 text-[13px] text-muted-foreground-2">
            <dt>
              <Hint>Cash</Hint>
            </dt>
            <dd className="tnum">{formatGBP(figures.cash)}</dd>
          </div>
        </dl>
      )}

      {saveError ? (
        <p role="alert" className="mt-6 max-w-[56ch] text-[13px] leading-[1.45] text-destructive">
          {saveError}
        </p>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center gap-x-8 gap-y-2 pt-12">
        {asking ? (
          <>
            <span className="text-[15px] text-foreground">Take the whole trade-in off?</span>
            <Button
              variant="text-destructive"
              className="min-h-14"
              data-testid="till-trade-remove-confirm"
              onClick={() => {
                setAsking(false)
                onRemove()
              }}
            >
              Yes, take it off
            </Button>
            <Button variant="text" className="min-h-14" onClick={() => setAsking(false)}>
              Keep it
            </Button>
          </>
        ) : (
          <Button variant="text-destructive" className="min-h-14" onClick={() => setAsking(true)}>
            Take the trade-in off
          </Button>
        )}
      </div>
    </section>
  )
}
