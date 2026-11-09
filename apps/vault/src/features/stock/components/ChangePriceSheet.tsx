import * as React from "react"
import { Button, Money, MoneyInput, PercentStepper, Segmented, Sheet } from "@/ui"

import { bulkPrice, ROUNDING_OPTIONS, type BulkMode as Mode } from "../pricing/bulk"
import type { RuleRounding } from "../pricing/rules"
import type { InventoryItem } from "../types"
import { SelectField } from "./SelectField"

export function ChangePriceSheet({
  open,
  onClose,
  items,
  busy,
  onApply,
}: {
  open: boolean
  onClose: () => void
  items: readonly InventoryItem[]
  busy: boolean
  onApply: (changes: { item: string; price: number }[]) => void
}) {
  const [mode, setMode] = React.useState<Mode>("market")
  const [value, setValue] = React.useState<number | null>(null)
  const [marketPct, setMarketPct] = React.useState(100)
  const [adjustPct, setAdjustPct] = React.useState(-10)
  const [rounding, setRounding] = React.useState<RuleRounding>("charm_99")

  const pct = mode === "market" ? marketPct : adjustPct
  const changes = items
    .map((item) => ({ item, price: bulkPrice(item, mode, value, pct, rounding) }))
    .filter((row): row is { item: InventoryItem; price: number } => row.price !== null && row.price !== row.item.price)
  const before = changes.reduce((sum, row) => sum + row.item.price * row.item.qty, 0)
  const after = changes.reduce((sum, row) => sum + row.price * row.item.qty, 0)
  const skipped = items.length - changes.length

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Change price"
      description={`${items.length} ${items.length === 1 ? "item" : "items"} selected`}
      footer={
        <Button
          block
          size="lg"
          disabled={changes.length === 0}
          loading={busy}
          onClick={() => onApply(changes.map((row) => ({ item: row.item.id, price: row.price })))}
        >
          {changes.length === 0 ? "Nothing to change" : `Reprice ${changes.length}`}
        </Button>
      }
    >
      <div className="flex flex-col gap-4 pt-2">
        <Segmented
          label="How to price"
          block
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "market", label: "% of market" },
            { value: "adjust", label: "+/- %" },
            { value: "set", label: "Set price" },
          ]}
        />
        {mode === "set" && <MoneyInput label="New sticker price" size="lg" value={value} onChange={setValue} />}
        {mode === "market" && (
          <PercentStepper label="Percent of market" value={marketPct} onChange={setMarketPct} min={10} max={300} />
        )}
        {mode === "adjust" && (
          <PercentStepper label="Change the sticker by" value={adjustPct} onChange={setAdjustPct} min={-90} max={200} tone="pop" />
        )}
        {mode !== "set" && (
          <SelectField
            label="Rounding"
            value={rounding}
            onChange={(v) => setRounding(v as RuleRounding)}
            options={ROUNDING_OPTIONS}
          />
        )}
        <div className="rounded-md border border-line bg-panel-2 p-3.5">
          <div className="flex items-baseline justify-between">
            <span className="label-mono text-fg-3">Sticker value</span>
            <span className="flex items-baseline gap-2">
              <Money pence={before} size="sm" tone="muted" className="line-through" />
              <Money pence={after} tween className="font-bold" />
            </span>
          </div>
          {skipped > 0 && (
            <p className="mt-1.5 text-sm text-fg-3">
              {skipped} left alone: {mode === "market" ? "no market price, or" : mode === "adjust" ? "no sticker yet, or" : ""} already at that price.
            </p>
          )}
          {changes.length > 0 && (
            <ul className="mt-2.5 flex flex-col gap-1.5 text-sm">
              {changes.slice(0, 4).map((row) => (
                <li key={row.item.id} className="flex items-center justify-between gap-3">
                  <span className="truncate">{row.item.title}</span>
                  <span className="flex shrink-0 items-baseline gap-1.5">
                    <Money pence={row.item.price} size="sm" tone="muted" />
                    <span aria-hidden className="text-fg-3">to</span>
                    <Money pence={row.price} size="sm" className="font-semibold" />
                  </span>
                </li>
              ))}
              {changes.length > 4 && <li className="text-fg-3">and {changes.length - 4} more</li>}
            </ul>
          )}
        </div>
      </div>
    </Sheet>
  )
}
