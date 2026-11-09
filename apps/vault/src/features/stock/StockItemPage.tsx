import * as React from "react"
import { Link } from "@tanstack/react-router"
import { ArrowLeft, History, ListPlus, Package, Printer, Save } from "lucide-react"
import { displayCode, normaliseCode } from "@gg/shared/sku"

import { Badge, Button, Card, Chip, EmptyState, Input, Money, MoneyInput, PageHeader, Skeleton, useToast } from "@/ui"

import {
  addToPrintList,
  errorText,
  reprice,
  stampLabelPrinted,
  updateItem,
  useInventory,
  useLookups,
  usePriceHistory,
  useStockMutation,
  type ItemPatch,
} from "./api"
import { ItemThumb } from "./components/ItemThumb"
import { SelectField } from "./components/SelectField"
import { alertsFor } from "./health/health"
import { detailLine, marginPct } from "./lib/inventory"
import { loadPrinterLibrary } from "./labels/niimbot"
import { printPriceLabels, printRoute } from "./labels/print"
import { CONDITIONS, type InventoryItem } from "./types"

const KIND_LABEL: Record<string, string> = {
  single: "Single card",
  graded: "Graded card",
  sealed: "Sealed",
  retro: "Retro",
  accessory: "Accessory",
  other: "Other",
}

const MARKET_FROM: Record<string, string> = {
  uk_sold_manual: "UK sold comp",
  ebay_uk_asking: "eBay UK asking",
  cardmarket: "Cardmarket, converted to GBP",
  tcgplayer: "TCGplayer, converted to GBP",
  pricecharting_pal: "PriceCharting PAL, converted",
  pricecharting_ntsc: "PriceCharting NTSC, converted",
  intake: "Value at intake",
}

const SOURCE_LABEL = { manual: "By hand", rule: "Pricing rule", import: "Import", bulk: "Bulk change" } as const

function dateText(iso: string): string {
  if (!iso) return ""
  const d = new Date(iso.replace(" ", "T"))
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
}

/** `id` is the SKU (either form) or the record id. */
export function StockItemPage({ id }: { id: string }) {
  const inventory = useInventory()
  const code = normaliseCode(id)
  const item = inventory.data?.find((row) => row.sku === code || row.id === id)

  if (inventory.isPending) {
    return (
      <section>
        <Skeleton className="mb-4 h-10 w-48" />
        <Skeleton className="h-56 rounded-lg" />
      </section>
    )
  }
  if (!item) {
    return (
      <section>
        <BackLink />
        <EmptyState
          icon={<Package aria-hidden />}
          title="Not in stock"
          action={
            <Link to="/stock" className="font-semibold underline underline-offset-2">
              Back to stock
            </Link>
          }
        >
          {displayCode(code)} is not in current stock. It may have sold, or the code was mistyped.
        </EmptyState>
      </section>
    )
  }
  return <ItemView key={item.id} item={item} />
}

function BackLink() {
  return (
    <Link to="/stock" className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-fg-2 hover:text-fg">
      <ArrowLeft className="size-4" aria-hidden />
      Stock
    </Link>
  )
}

function ItemView({ item }: { item: InventoryItem }) {
  const toast = useToast()
  const lookups = useLookups()
  const history = usePriceHistory(item.id)
  const alerts = alertsFor(item)
  const margin = marginPct(item.price, item.cost)

  const [form, setForm] = React.useState({
    title: item.title,
    condition: item.condition,
    qty: item.qty,
    cost: item.cost as number | null,
    price: item.price as number | null,
    location: item.location,
    notes: item.notes,
  })
  const dirty =
    form.title !== item.title ||
    form.condition !== item.condition ||
    form.qty !== item.qty ||
    (form.cost ?? 0) !== item.cost ||
    (form.price ?? 0) !== item.price ||
    form.location !== item.location ||
    form.notes !== item.notes

  const save = useStockMutation(async () => {
    const patch: ItemPatch = {}
    if (form.title !== item.title) patch.title = form.title.trim()
    if (form.condition !== item.condition) patch.condition = form.condition
    if (form.qty !== item.qty) patch.qty = form.qty
    if ((form.cost ?? 0) !== item.cost) patch.cost = form.cost ?? 0
    if (form.location !== item.location) patch.location = form.location
    if (form.notes !== item.notes) patch.notes = form.notes
    if (Object.keys(patch).length) await updateItem(item.id, patch)
    if ((form.price ?? 0) !== item.price) await reprice([{ item: item.id, price: form.price ?? 0 }], "manual")
  })

  const listed = useStockMutation(() => addToPrintList([item]))
  const [printing, setPrinting] = React.useState(false)
  const route = printRoute()

  const print = async () => {
    setPrinting(true)
    try {
      const { count } = await printPriceLabels([{ sku: item.sku, title: item.title, price: item.price, copies: 1 }])
      if (count > 0) {
        await stampLabelPrinted(item.id).catch(() => undefined)
        toast({ message: route === "bluetooth" ? "Label printed." : "Label ready to share.", tone: "ok" })
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return
      toast({ message: errorText(error, "The label did not print. Try again."), tone: "alert", duration: 8000 })
    } finally {
      setPrinting(false)
    }
  }

  return (
    <section className="pb-6">
      <BackLink />
      <PageHeader eyebrow={displayCode(item.sku)} title={item.title} />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_1.1fr]">
        <div className="flex flex-col gap-4">
          <Card accent={alerts.some((a) => a.severity === "alert") ? "pop" : "volt"} className="relative overflow-hidden">
            <div aria-hidden className="pointer-events-none absolute -top-20 -right-20 size-56 rounded-full bg-volt/20 blur-3xl dark:bg-volt/10" />
            <div className="relative flex gap-4">
              <ItemThumb item={item} className="w-28 rounded-[8px]" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div>
                  <p className="label-mono text-fg-3">Sticker</p>
                  {item.price > 0 ? <Money pence={item.price} size="xl" /> : <p className="font-display text-3xl text-pop-text uppercase">No price</p>}
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
                  <div>
                    <dt className="label-mono text-[10px] text-fg-3">Market</dt>
                    <dd>{item.market !== null ? <Money pence={item.market} size="sm" className="font-semibold" /> : <span className="text-fg-3">None</span>}</dd>
                  </div>
                  <div>
                    <dt className="label-mono text-[10px] text-fg-3">Cost</dt>
                    <dd>{item.cost > 0 ? <Money pence={item.cost} size="sm" className="font-semibold" /> : <span className="text-fg-3">None</span>}</dd>
                  </div>
                  <div>
                    <dt className="label-mono text-[10px] text-fg-3">Margin</dt>
                    <dd className="font-mono font-semibold tnum">{margin !== null ? `${margin}%` : "None"}</dd>
                  </div>
                  <div>
                    <dt className="label-mono text-[10px] text-fg-3">Qty</dt>
                    <dd className="font-mono font-semibold tnum">{item.qty}</dd>
                  </div>
                </dl>
              </div>
            </div>
            {alerts.length > 0 && (
              <ul className="relative mt-4 flex flex-wrap gap-1.5">
                {alerts.map((a) => (
                  <li key={a.key}>
                    <Badge tone={a.severity === "alert" ? "pop" : a.severity === "warn" ? "warn" : "info"} dot>
                      {a.title}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            <div className="relative mt-4 grid grid-cols-2 gap-2">
              <Button
                icon={<Printer className="size-4" aria-hidden />}
                loading={printing}
                disabled={item.price <= 0}
                onPointerEnter={() => void loadPrinterLibrary().catch(() => undefined)}
                onClick={print}
              >
                {route === "bluetooth" ? "Print label" : "Share label"}
              </Button>
              <Button
                variant="secondary"
                icon={<ListPlus className="size-4" aria-hidden />}
                loading={listed.isPending}
                onClick={() =>
                  listed.mutate(undefined, {
                    onSuccess: () => toast({ message: "On the print list.", tone: "ok" }),
                    onError: (error) => toast({ message: errorText(error, "Not added. Try again."), tone: "alert" }),
                  })
                }
              >
                Print list
              </Button>
            </div>
          </Card>

          <Card>
            <h2 className="label-mono mb-3 text-fg-2">Details</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-fg-3">Type</dt>
              <dd>{KIND_LABEL[item.kind] ?? item.kind}</dd>
              {item.game_name && (
                <>
                  <dt className="text-fg-3">Game</dt>
                  <dd>{item.game_name}</dd>
                </>
              )}
              {detailLine(item) && (
                <>
                  <dt className="text-fg-3">Card</dt>
                  <dd className="font-mono">{detailLine(item)}</dd>
                </>
              )}
              {item.category_path && (
                <>
                  <dt className="text-fg-3">Filed under</dt>
                  <dd>{item.category_path}</dd>
                </>
              )}
              <dt className="text-fg-3">Market from</dt>
              <dd>{item.market_source ? (MARKET_FROM[item.market_source] ?? item.market_source) : "Nothing on file"}</dd>
              <dt className="text-fg-3">Added</dt>
              <dd>{dateText(item.acquired_at || item.created)}</dd>
              <dt className="text-fg-3">Label</dt>
              <dd>{item.label_printed_at ? `Printed ${dateText(item.label_printed_at)}` : "Not printed yet"}</dd>
            </dl>
          </Card>

          <Card>
            <h2 className="label-mono mb-3 flex items-center gap-2 text-fg-2">
              <History className="size-4" aria-hidden />
              Price history
            </h2>
            {history.isPending ? (
              <Skeleton lines={2} />
            ) : (history.data ?? []).length === 0 ? (
              <p className="text-sm text-fg-3">No price changes yet. Changes made here, in bulk or by a pricing rule show up here.</p>
            ) : (
              <ol className="flex flex-col divide-y divide-line">
                {history.data?.map((h) => (
                  <li key={h.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="min-w-0">
                      <span className="block">{dateText(h.created)}</span>
                      <span className="block truncate text-xs text-fg-3">
                        {SOURCE_LABEL[h.source] ?? h.source}
                        {h.expand?.staff?.name ? `, ${h.expand.staff.name}` : ""}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-baseline gap-1.5">
                      <Money pence={h.old_price} size="sm" tone="muted" />
                      <span className="text-fg-3">to</span>
                      <Money pence={h.new_price} size="sm" className="font-semibold" />
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <Card className="flex h-fit flex-col gap-4">
          <h2 className="label-mono text-fg-2">Edit</h2>
          <Input label="Name" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
          {item.kind === "single" && (
            <div className="flex flex-col gap-1.5">
              <span className="label-mono text-fg-2">Condition</span>
              <div role="radiogroup" aria-label="Condition" className="flex gap-1.5">
                {CONDITIONS.map((c) => (
                  <Chip
                    key={c}
                    role="radio"
                    aria-checked={form.condition === c}
                    selected={form.condition === c}
                    onClick={() => setForm((f) => ({ ...f, condition: c }))}
                    className="h-11 flex-1 justify-center px-0 font-mono"
                  >
                    {c}
                  </Chip>
                ))}
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <MoneyInput label="Sticker price" value={form.price} onChange={(v) => setForm((f) => ({ ...f, price: v }))} />
            <MoneyInput label="Cost each" value={form.cost} onChange={(v) => setForm((f) => ({ ...f, cost: v }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Quantity"
              mono
              inputMode="numeric"
              value={String(form.qty)}
              onChange={(e) => setForm((f) => ({ ...f, qty: Math.max(0, Number(e.target.value.replace(/\D/g, "")) || 0) }))}
            />
            <SelectField
              label="Location"
              value={form.location}
              onChange={(v) => setForm((f) => ({ ...f, location: v }))}
              placeholder="Not shelved"
              options={(lookups.data?.locations ?? []).map((l) => ({ value: l.id, label: l.name }))}
            />
          </div>
          <Input label="Notes" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Optional" />
          {(form.price ?? 0) !== item.price && item.label_printed_at && (
            <p className="text-sm text-warn">The printed label will need a reprint. It moves to Needs reprint on the print list.</p>
          )}
          <Button
            size="lg"
            block
            disabled={!dirty}
            loading={save.isPending}
            icon={<Save className="size-5" aria-hidden />}
            onClick={() =>
              save.mutate(undefined, {
                onSuccess: () => toast({ message: "Saved.", tone: "ok" }),
                onError: (error) => toast({ message: errorText(error, "Not saved. Check the fields and try again."), tone: "alert" }),
              })
            }
          >
            Save changes
          </Button>
        </Card>
      </div>
    </section>
  )
}
