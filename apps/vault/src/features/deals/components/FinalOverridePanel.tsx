import * as React from "react"
import { PenLine, RotateCcw } from "lucide-react"
import { effectivePct, type Deal, type DealOverrides, type FinalOverride } from "@gg/shared/deal"
import { formatGBP } from "@gg/shared/money"

import { cn } from "@/lib/cn"
import { Badge, Button, Money, MoneyInput, Segmented } from "@/ui"

import { formatPct } from "../format"
import type { DealAction, Side } from "../state"

export interface FinalOverridePanelProps {
  deal: Deal
  overrides: DealOverrides
  dispatch: React.Dispatch<DealAction>
}

/**
 * The last word on the figure: key a final trade or cash total, or a new %
 * of market. Every line rescales and the pennies add up (computeDeal).
 */
export function FinalOverridePanel({ deal, overrides, dispatch }: FinalOverridePanelProps) {
  return (
    <section aria-labelledby="final-figure" className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between px-1">
        <h2 id="final-figure" className="label-mono text-fg-2">
          Final figure
        </h2>
        <p className="text-xs text-fg-3">Rescales every line</p>
      </div>
      <div className="divide-y divide-line rounded-lg border border-line bg-panel shadow-panel dark:bg-panel-2">
        <OverrideRow
          side="trade"
          label="Trade credit"
          market={deal.market}
          calculated={deal.calculatedTrade}
          final={deal.trade}
          override={overrides.trade ?? null}
          disabled={deal.lines.length === 0}
          dispatch={dispatch}
        />
        <OverrideRow
          side="cash"
          label="Cash"
          market={deal.market}
          calculated={deal.calculatedCash}
          final={deal.cash}
          override={overrides.cash ?? null}
          disabled={deal.lines.length === 0}
          dispatch={dispatch}
        />
      </div>
    </section>
  )
}

type Mode = "amount" | "pct"

function OverrideRow({
  side,
  label,
  market,
  calculated,
  final,
  override,
  disabled,
  dispatch,
}: {
  side: Side
  label: string
  market: number
  calculated: number
  final: number
  override: FinalOverride | null
  disabled: boolean
  dispatch: React.Dispatch<DealAction>
}) {
  const [editing, setEditing] = React.useState(false)
  const [mode, setMode] = React.useState<Mode>(override?.kind ?? "amount")
  const [amount, setAmount] = React.useState<number | null>(override?.kind === "amount" ? override.pence : null)
  const [pct, setPct] = React.useState(override?.kind === "pct" ? String(override.pct) : "")

  const apply = (event: React.FormEvent) => {
    event.preventDefault()
    let next: FinalOverride | null = null
    if (mode === "amount" && amount !== null) next = { kind: "amount", pence: amount }
    if (mode === "pct") {
      const parsed = Number.parseFloat(pct)
      if (Number.isFinite(parsed) && parsed >= 0) next = { kind: "pct", pct: Math.min(200, parsed) }
    }
    if (!next) return
    dispatch({ type: "setOverride", side, override: next })
    setEditing(false)
  }

  const tone = side === "trade" ? "pop" : "volt"

  return (
    <div className="px-4 py-3.5" data-testid={`override-${side}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <span className={cn("size-2 shrink-0 rounded-full", side === "trade" ? "bg-pop" : "bg-volt")} aria-hidden />
          {label}
        </p>
        <div className="flex shrink-0 gap-1">
          {override && (
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCcw className="size-4" aria-hidden />}
              onClick={() => {
                dispatch({ type: "setOverride", side, override: null })
                setEditing(false)
              }}
            >
              Reset
            </Button>
          )}
          {!editing && (
            <Button
              size="sm"
              variant="secondary"
              disabled={disabled}
              icon={<PenLine className="size-4" aria-hidden />}
              onClick={() => setEditing(true)}
            >
              {override ? "Change" : "Set"}
            </Button>
          )}
        </div>
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2.5">
        <Money pence={final} tween size="lg" tone={tone} />
        {override && (
          <s className="font-mono text-sm text-fg-3 tnum" aria-label={`Calculated ${formatGBP(calculated)}`}>
            {formatGBP(calculated)}
          </s>
        )}
      </div>
      <p className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-fg-3 tnum">
        {formatPct(effectivePct(final, market))} of market
        {override && <Badge tone={side === "trade" ? "pop" : "volt"}>Overridden</Badge>}
      </p>

      {editing && (
        <form onSubmit={apply} className="mt-3 flex flex-col gap-3">
          <Segmented<Mode>
            label={`${label} final figure as`}
            size="sm"
            block
            tone={side === "trade" ? "pop" : "volt"}
            value={mode}
            onChange={setMode}
            options={[
              { value: "amount", label: "Amount" },
              { value: "pct", label: "% of market" },
            ]}
          />
          <div className="flex items-end gap-2">
            {mode === "amount" ? (
              <MoneyInput
                className="flex-1"
                label={`Final ${label.toLowerCase()}`}
                value={amount}
                onChange={setAmount}
                autoFocus
              />
            ) : (
              <label className="flex flex-1 flex-col gap-1.5">
                <span className="label-mono text-fg-2">Final % of market</span>
                <span className="flex h-12 items-center gap-2 rounded-md border border-line-2 bg-panel-2 px-3.5 focus-within:border-volt">
                  <input
                    inputMode="decimal"
                    autoFocus
                    value={pct}
                    onChange={(e) => setPct(e.target.value.replace(/[^\d.]/g, ""))}
                    placeholder={String(effectivePct(calculated, market))}
                    className="min-w-0 flex-1 bg-transparent font-mono text-base tnum outline-none placeholder:text-fg-3"
                  />
                  <span className="font-mono text-fg-3" aria-hidden>
                    %
                  </span>
                </span>
              </label>
            )}
            <Button type="submit" variant={side === "trade" ? "pop" : "primary"}>
              Apply
            </Button>
          </div>
          <button type="button" className="self-start text-sm text-fg-2 underline underline-offset-4" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      )}
    </div>
  )
}
