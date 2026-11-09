import * as React from "react"
import { IdCard, ShieldAlert } from "lucide-react"
import type { Deal, DealPayoutType } from "@gg/shared/deal"
import { formatGBP } from "@gg/shared/money"

import { cn } from "@/lib/cn"
import { Button, Money, MoneyInput, Segmented, Sheet } from "@/ui"

import { draftPayout, needsIdCheck, roundingSuggestions, type DealAction } from "../state"
import type { DealDraft } from "../types"

export interface ReviewSheetProps {
  open: boolean
  onClose: () => void
  draft: DealDraft
  deal: Deal
  dispatch: React.Dispatch<DealAction>
  onComplete: () => void
  completing: boolean
  /** Set when completing failed, shown above the button. */
  error?: string | null
}

const PAYOUTS: ReadonlyArray<{ value: DealPayoutType; label: string }> = [
  { value: "credit", label: "Trade credit" },
  { value: "cash", label: "Cash" },
  { value: "mixed", label: "Split" },
]

/** Choose how the customer is paid, settle the final figure, and complete. */
export function ReviewSheet({ open, onClose, draft, deal, dispatch, onComplete, completing, error }: ReviewSheetProps) {
  const type = draft.payout.type
  const payout = draftPayout(draft, deal)
  const paid = payout.cash + payout.credit
  const captured = deal.market - paid
  const idNeeded = needsIdCheck(payout)

  // The figure the rounding chips act on.
  const roundingTarget = type === "credit" ? deal.trade : type === "cash" ? deal.cash : payout.cash
  const suggestions = roundingSuggestions(roundingTarget).filter((s) => type !== "mixed" || s.pence <= deal.cash)

  const applyRounding = (pence: number) => {
    if (type === "mixed") dispatch({ type: "setCashTaken", pence })
    else dispatch({ type: "setOverride", side: type === "credit" ? "trade" : "cash", override: { kind: "amount", pence } })
  }

  const overridden = type === "credit" ? deal.tradeOverridden : type === "cash" ? deal.cashOverridden : deal.tradeOverridden || deal.cashOverridden

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Review deal"
      description={`${draft.name}, ${deal.lines.length} ${deal.lines.length === 1 ? "line" : "lines"}`}
      footer={
        <div className="flex flex-col gap-2">
          {idNeeded && (
            <p className="text-sm font-medium text-pop-text" role="note" data-testid="cash-blocked">
              Cash needs ID on file, and that check is not connected here yet. Pay as trade credit, or complete it on
              the counter.
            </p>
          )}
          {error && !idNeeded && (
            <p className="text-sm font-medium text-pop-text" role="alert">
              {error}
            </p>
          )}
          <Button block size="lg" onClick={onComplete} loading={completing} disabled={idNeeded || paid <= 0}>
            Complete deal, {formatGBP(paid)}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5 pt-1">
        <Segmented<DealPayoutType>
          label="Pay out as"
          block
          size="sm"
          tone={type === "credit" ? "pop" : type === "cash" ? "volt" : "ink"}
          value={type}
          onChange={(value) => dispatch({ type: "setPayoutType", payoutType: value })}
          options={PAYOUTS}
        />

        {type === "mixed" && (
          <MoneyInput
            label="Cash they want"
            hint={`Up to ${formatGBP(deal.cash)}. The rest converts to trade credit.`}
            value={draft.payout.cashTaken || null}
            onChange={(pence) => dispatch({ type: "setCashTaken", pence: Math.min(pence ?? 0, deal.cash) })}
            size="lg"
          />
        )}

        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line" data-testid="payout">
          <PayoutFigure label="Trade credit" pence={payout.credit} side="trade" active={payout.credit > 0} />
          <PayoutFigure label="Cash" pence={payout.cash} side="cash" active={payout.cash > 0} />
        </div>
        {overridden && (
          <p className="-mt-3 text-xs text-fg-2">
            Final figure overridden. Calculated{" "}
            {type !== "cash" && (
              <>
                trade <s className="font-mono tnum">{formatGBP(deal.calculatedTrade)}</s>
              </>
            )}
            {type === "mixed" && ", "}
            {type !== "credit" && (
              <>
                cash <s className="font-mono tnum">{formatGBP(deal.calculatedCash)}</s>
              </>
            )}
            .
          </p>
        )}

        {suggestions.length > 0 && (
          <section aria-labelledby="rounding" className="flex flex-col gap-2">
            <h3 id="rounding" className="label-mono text-fg-2">
              {type === "mixed" ? "Round the cash" : "Round the final figure"}
            </h3>
            <div className="grid grid-cols-3 gap-2">
              {suggestions.map((s) => (
                <button
                  key={s.step}
                  type="button"
                  onClick={() => applyRounding(s.pence)}
                  className="flex flex-col items-start rounded-md border border-line-2 bg-panel-2 px-3 py-2 text-left transition-colors hover:border-fg-3 active:scale-[0.98]"
                >
                  <span className="font-mono text-[15px] font-bold tnum">{formatGBP(s.pence)}</span>
                  <span className={cn("font-mono text-[11px] tnum", s.diff < 0 ? "text-fg-3" : "text-ok")}>
                    {s.diff < 0 ? "-" : "+"}
                    {formatGBP(Math.abs(s.diff))}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        <dl className="flex flex-col divide-y divide-line border-y border-line">
          <SummaryRow label="Market value" pence={deal.market} />
          <SummaryRow label="Paid" pence={paid} />
          <SummaryRow label="Value captured" pence={captured} strong />
        </dl>

        {idNeeded && (
          <div className="flex gap-3 rounded-md border border-pop/50 bg-pop/8 p-3.5" data-testid="id-required">
            <IdCard className="mt-0.5 size-5 shrink-0 text-pop-text" aria-hidden />
            <div>
              <p className="font-semibold">ID on file required</p>
              <p className="text-sm text-fg-2">
                This deal pays {formatGBP(payout.cash)} in cash. Any cash, however small, needs the seller's photo ID
                checked and on file first.
              </p>
            </div>
          </div>
        )}
        {!idNeeded && type !== "credit" && paid > 0 && (
          <p className="flex items-center gap-2 text-sm text-fg-2">
            <ShieldAlert className="size-4" aria-hidden />
            No cash in this payout, so no ID check.
          </p>
        )}

        <label className="flex flex-col gap-1.5">
          <span className="label-mono text-fg-2">Note (optional)</span>
          <textarea
            rows={2}
            value={draft.note}
            onChange={(e) => dispatch({ type: "setNote", note: e.target.value })}
            placeholder="Anything the next person should know"
            className="rounded-md border border-line-2 bg-panel-2 px-3.5 py-3 text-base outline-none placeholder:text-fg-3 focus:border-volt"
          />
        </label>
      </div>
    </Sheet>
  )
}

function PayoutFigure({ label, pence, side, active }: { label: string; pence: number; side: "trade" | "cash"; active: boolean }) {
  return (
    <div className={cn("flex flex-col gap-1 bg-panel px-4 py-3 dark:bg-bg-2", !active && "opacity-55")}>
      <span className="label-mono flex items-center gap-1.5 text-fg-2">
        <span className={cn("size-1.5 rounded-full", side === "trade" ? "bg-pop" : "bg-volt")} aria-hidden />
        {label}
      </span>
      <Money pence={pence} tween size="lg" tone={active ? (side === "trade" ? "pop" : "volt") : "muted"} />
    </div>
  )
}

function SummaryRow({ label, pence, strong }: { label: string; pence: number; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between py-2.5">
      <dt className={cn("text-sm", strong ? "font-semibold" : "text-fg-2")}>{label}</dt>
      <dd>
        <Money pence={pence} tween tone={strong ? "ok" : "default"} className={strong ? "font-bold" : undefined} />
      </dd>
    </div>
  )
}
