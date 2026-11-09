import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { BookOpen, Disc3, ExternalLink, Gamepad2, Minus, Package, Plus, RotateCcw, SlidersHorizontal, Trash2 } from "lucide-react"
import type { DealLine } from "@gg/shared/deal"
import { formatGBP } from "@gg/shared/money"

import { cn } from "@/lib/cn"
import { Badge, IconButton, Money, MoneyInput } from "@/ui"

import { formatPct, variantLabel } from "../format"
import {
  conditionPrice,
  ebaySoldUrl,
  LINE_QUICK_PCTS,
  lineMarket,
  lineOverridden,
  linePriced,
  type DealAction,
  type Side,
} from "../state"
import { CONDITIONS, CUSTOM_CATEGORIES, type DraftLine } from "../types"

export interface DealLineRowProps {
  line: DraftLine
  priced: DealLine
  dispatch: React.Dispatch<DealAction>
  onRetryPrices?: (lineId: string) => void
}

const customIcons = { retro: Gamepad2, comic: BookOpen, sealed: Package, other: Disc3 }

/** One line of the deal: what it is, its condition and quantity, and both figures side by side. */
export function DealLineRow({ line, priced, dispatch, onRetryPrices }: DealLineRowProps) {
  const [ratesOpen, setRatesOpen] = React.useState(false)
  const overridden = lineOverridden(line)
  const unitMarket = lineMarket(line)
  const priced_ = linePriced(line)
  const loading = line.kind === "card" && line.priceStatus === "loading"
  const failed = line.kind === "card" && line.priceStatus === "error"
  const basis = line.kind === "card" ? line.prices[line.condition]?.basis : undefined
  const needsValue = !loading && !priced_
  const showTyped =
    line.kind === "custom" || (line.kind === "card" && !loading && conditionPrice(line) === null)

  return (
    <div className="relative py-4" data-testid="deal-line">
      {overridden && (
        <span className="absolute top-4 bottom-4 -left-4 w-[3px] rounded-r-full bg-pop sm:-left-5" aria-hidden />
      )}
      <div className="grid grid-cols-[60px_1fr] gap-3">
        <LineImage line={line} />
        <div className="min-w-0">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 leading-snug font-semibold">{line.name || "Untitled item"}</p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {line.kind === "card" ? (
                  <span className="font-mono text-xs text-fg-2 tnum">
                    {[line.setName, line.number].filter(Boolean).join(" · ")}
                  </span>
                ) : (
                  <span className="font-mono text-xs text-fg-2">
                    {CUSTOM_CATEGORIES.find((c) => c.value === line.category)?.label ?? "Custom item"}
                  </span>
                )}
                {line.kind === "card" && line.variant && <Badge tone="info">{variantLabel(line.variant)}</Badge>}
                {overridden && (
                  <Badge tone="pop" data-testid="override-marker">
                    Own rate
                  </Badge>
                )}
              </div>
            </div>
            <IconButton
              label={`Remove ${line.name || "item"}`}
              size="sm"
              className="-mt-1 -mr-2"
              onClick={() => dispatch({ type: "removeLine", lineId: line.id })}
            >
              <Trash2 aria-hidden />
            </IconButton>
          </div>

          {line.kind === "card" && (
            <div className="mt-3 flex gap-1" role="radiogroup" aria-label="Condition">
              {CONDITIONS.map((condition) => {
                const active = condition === line.condition
                const has = conditionPrice(line, condition) !== null
                return (
                  <button
                    key={condition}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => dispatch({ type: "setCondition", lineId: line.id, condition })}
                    className={cn(
                      "h-8 min-w-0 flex-1 rounded-sm border font-mono text-xs font-bold transition-colors duration-150",
                      active
                        ? "border-transparent bg-ink text-paper dark:bg-paper dark:text-ink"
                        : "border-line-2 bg-panel-2 text-fg-2 hover:text-fg",
                      !active && !has && line.priceStatus === "ready" && "text-fg-3 line-through decoration-1"
                    )}
                  >
                    {condition}
                  </button>
                )
              })}
            </div>
          )}

          <div className="mt-3 flex items-center justify-between gap-2">
            <div className={cn("min-w-0", showTyped && "invisible")}>
              <p className="label-mono text-fg-3">
                Market{line.qty > 1 ? " each" : ""}
                {basis === "estimated" && <span className="ml-1.5 text-warn">Est.</span>}
              </p>
              {loading ? (
                <span className="mt-1 block h-5 w-20 animate-pulse rounded-sm bg-line-2" aria-label="Loading price" />
              ) : showTyped ? null : (
                <Money pence={unitMarket} className="font-bold" />
              )}
            </div>
            <QtyStepper
              qty={line.qty}
              name={line.name}
              onChange={(qty) => dispatch({ type: "setQty", lineId: line.id, qty })}
            />
          </div>
        </div>
      </div>

      {showTyped && (
        <div className="mt-3">
          <MoneyInput
            label={line.kind === "custom" ? "Market value each" : `No ${line.condition} price. Market value each`}
            value={line.manualMarket}
            onChange={(pence) => dispatch({ type: "setManualMarket", lineId: line.id, pence })}
            error={failed ? "Prices did not load. Type a value or try again." : null}
          />
          {failed && onRetryPrices && (
            <button
              type="button"
              className="mt-1 text-sm font-medium underline underline-offset-4"
              onClick={() => onRetryPrices(line.id)}
            >
              Try prices again
            </button>
          )}
        </div>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line">
        <Figure
          side="trade"
          label="Trade"
          pct={priced.tradePct}
          custom={priced.tradeCustom}
          unit={unitMarket}
          qty={line.qty}
          calculated={priced.calculatedTrade}
          final={priced.trade}
          muted={needsValue}
        />
        <Figure
          side="cash"
          label="Cash"
          pct={priced.cashPct}
          custom={priced.cashCustom}
          unit={unitMarket}
          qty={line.qty}
          calculated={priced.calculatedCash}
          final={priced.cash}
          muted={needsValue}
        />
      </dl>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <button
          type="button"
          aria-expanded={ratesOpen}
          onClick={() => setRatesOpen((v) => !v)}
          className="flex h-9 items-center gap-1.5 text-sm font-medium text-fg-2 hover:text-fg"
        >
          <SlidersHorizontal className="size-4" aria-hidden />
          Line rates
        </button>
        {overridden && (
          <button
            type="button"
            onClick={() => dispatch({ type: "resetLineRates", lineId: line.id })}
            className="flex h-9 items-center gap-1.5 text-sm font-medium text-pop-text"
          >
            <RotateCcw className="size-4" aria-hidden />
            Reset to sweep
          </button>
        )}
        <a
          href={ebaySoldUrl(line)}
          target="_blank"
          rel="noreferrer"
          className="ml-auto flex h-9 items-center gap-1.5 text-sm font-medium text-fg-2 hover:text-fg"
        >
          eBay sold
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      </div>

      <AnimatePresence initial={false}>
        {ratesOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-1 flex flex-col gap-2 rounded-md bg-panel-2 p-3">
              <LineRateRow
                side="trade"
                label="Trade"
                value={line.tradePct}
                onChange={(pct) => dispatch({ type: "setLineRate", lineId: line.id, side: "trade", pct })}
              />
              <LineRateRow
                side="cash"
                label="Cash"
                value={line.cashPct}
                onChange={(pct) => dispatch({ type: "setLineRate", lineId: line.id, side: "cash", pct })}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function LineImage({ line }: { line: DraftLine }) {
  if (line.kind === "card" && line.image) {
    return (
      <img
        src={line.image}
        alt=""
        width={60}
        height={84}
        loading="lazy"
        className="h-[84px] w-[60px] object-contain [filter:drop-shadow(0_1px_1px_rgba(11,11,11,.05))_drop-shadow(0_8px_14px_rgba(11,11,11,.14))]"
      />
    )
  }
  const Icon = line.kind === "custom" ? customIcons[line.category] : Disc3
  return (
    <div className="flex h-[84px] w-[60px] items-center justify-center rounded-sm border border-dashed border-line-2 text-fg-3">
      <Icon className="size-6" strokeWidth={1.25} aria-hidden />
    </div>
  )
}

function QtyStepper({ qty, name, onChange }: { qty: number; name: string; onChange: (qty: number) => void }) {
  return (
    <div className="flex h-9 shrink-0 items-center rounded-full border border-line-2 bg-panel-2">
      <button
        type="button"
        aria-label={`One fewer ${name}`}
        disabled={qty <= 1}
        onClick={() => onChange(qty - 1)}
        className="flex size-9 items-center justify-center rounded-full text-fg-2 hover:text-fg disabled:opacity-35"
      >
        <Minus className="size-4" aria-hidden />
      </button>
      <span className="w-7 text-center font-mono text-sm font-bold tnum" aria-label={`Quantity ${qty}`}>
        {qty}
      </span>
      <button
        type="button"
        aria-label={`One more ${name}`}
        onClick={() => onChange(qty + 1)}
        className="flex size-9 items-center justify-center rounded-full text-fg-2 hover:text-fg"
      >
        <Plus className="size-4" aria-hidden />
      </button>
    </div>
  )
}

interface FigureProps {
  side: Side
  label: string
  pct: number
  custom: boolean
  unit: number
  qty: number
  calculated: number
  final: number
  muted: boolean
}

function Figure({ side, label, pct, custom, unit, qty, calculated, final, muted }: FigureProps) {
  const rescaled = final !== calculated
  return (
    <div className="flex min-w-0 flex-col gap-0.5 bg-panel px-3 py-2.5 dark:bg-bg-2">
      <dt className="label-mono flex items-center gap-1.5 text-fg-3">
        <span
          className={cn("size-1.5 rounded-full", side === "trade" ? "bg-pop" : "bg-volt")}
          aria-hidden
        />
        {label} <span className={cn("tnum", custom && "text-pop-text")}>{formatPct(pct)}</span>
      </dt>
      <dd className="min-w-0">
        <Money
          pence={final}
          tween
          tone={muted ? "muted" : side === "trade" ? "pop" : "volt"}
          className="font-bold"
        />
        <p className="font-mono text-[11px] leading-snug text-fg-3 tnum" data-testid={`breakdown-${side}`}>
          {rescaled ? (
            <>
              <s>{formatGBP(calculated)}</s> before final
            </>
          ) : (
            `${formatPct(pct)} of ${formatGBP(unit)}${qty > 1 ? ` x ${qty}` : ""} = ${formatGBP(calculated)}`
          )}
        </p>
      </dd>
    </div>
  )
}

function LineRateRow({
  side,
  label,
  value,
  onChange,
}: {
  side: Side
  label: string
  value: number | undefined
  onChange: (pct: number | null) => void
}) {
  const [draft, setDraft] = React.useState<string | null>(null)
  const quick = (LINE_QUICK_PCTS as readonly number[]).includes(value ?? -1)
  const commit = (text: string) => {
    setDraft(null)
    if (text.trim() === "") return onChange(null)
    const parsed = Number.parseInt(text.replace(/[^\d]/g, ""), 10)
    if (Number.isFinite(parsed)) onChange(parsed)
  }
  return (
    <div className="flex items-center gap-1.5">
      <span className="label-mono w-12 shrink-0 text-fg-2">{label}</span>
      {LINE_QUICK_PCTS.map((pct) => {
        const active = value === pct
        return (
          <button
            key={pct}
            type="button"
            aria-pressed={active}
            aria-label={`${label} ${pct}% for this line`}
            onClick={() => onChange(active ? null : pct)}
            className={cn(
              "h-8 flex-1 rounded-full border font-mono text-xs font-bold tnum transition-colors duration-150",
              active
                ? side === "trade"
                  ? "border-transparent bg-pop text-on-pop"
                  : "border-transparent bg-volt text-on-volt"
                : "border-line-2 bg-panel text-fg-2 hover:text-fg dark:bg-bg-2"
            )}
          >
            {pct}%
          </button>
        )
      })}
      <label
        className={cn(
          "flex h-8 w-[68px] shrink-0 items-center rounded-full border bg-panel px-2.5 dark:bg-bg-2",
          value !== undefined && !quick ? "border-fg" : "border-line-2"
        )}
      >
        <input
          aria-label={`${label} custom % for this line`}
          inputMode="numeric"
          placeholder="Own"
          value={draft ?? (value !== undefined && !quick ? String(value) : "")}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit(e.currentTarget.value)
          }}
          className="w-full min-w-0 bg-transparent text-right font-mono text-xs font-bold tnum outline-none placeholder:font-sans placeholder:font-normal placeholder:text-fg-3"
        />
        <span className="font-mono text-xs text-fg-3" aria-hidden>
          %
        </span>
      </label>
    </div>
  )
}
