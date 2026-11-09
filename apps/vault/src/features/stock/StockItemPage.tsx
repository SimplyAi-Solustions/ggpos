import * as React from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import {
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  ChartLine,
  Handshake,
  History,
  ListPlus,
  MapPin,
  Package,
  PencilLine,
  Printer,
  Receipt,
  ShieldAlert,
  Tag,
  Trash2,
  Truck,
} from "lucide-react"
import { formatGBP } from "@gg/shared/money"
import { displayCode, normaliseCode } from "@gg/shared/sku"

import { cn } from "@/lib/cn"
import { Badge, Button, EmptyState, Money, Skeleton, useToast } from "@/ui"

import {
  addToPrintList,
  errorText,
  reprice,
  stampLabelPrinted,
  updateItem,
  useInventory,
  useItemOrigin,
  useLookups,
  usePriceHistory,
  useStockMutation,
  type ItemOrigin,
  type ItemPatch,
  type PriceChange,
} from "./api"
import { ChangePriceSheet } from "./components/ChangePriceSheet"
import { EposStatus } from "./components/EposStatus"
import { ItemArt } from "./components/ItemArt"
import { AddToDealSheet, ConfirmSheet, EditDetailsSheet, MoveSheet } from "./components/ItemSheets"
import { alertsFor } from "./health/health"
import { marginPct } from "./lib/inventory"
import {
  CONDITION_LABEL,
  dateText,
  isCard,
  KIND_LABEL,
  MARKET_FROM,
  marginTone,
  marketLabel,
  setLine,
  variantTag,
} from "./lib/item-view"
import { loadPrinterLibrary } from "./labels/niimbot"
import { printPriceLabels, printRoute } from "./labels/print"
import type { InventoryItem } from "./types"

const SOURCE_LABEL = { manual: "By hand", rule: "Pricing rule", import: "Import", bulk: "Bulk change" } as const

const STATUS_BADGE: Record<string, { label: string; tone: "info" | "warn" | "violet" } | undefined> = {
  reserved: { label: "Reserved", tone: "warn" },
  listed_ebay: { label: "On eBay", tone: "info" },
}

/** `id` is the SKU (either form) or the record id. */
export function StockItemPage({ id }: { id: string }) {
  const inventory = useInventory()
  const code = normaliseCode(id)
  const item = inventory.data?.find((row) => row.sku === code || row.id === id)

  if (inventory.isPending) {
    return (
      <section className="flex flex-col items-center gap-4">
        <Skeleton className="mt-6 aspect-[5/7] w-[62%] max-w-[280px] rounded-[14px]" />
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-24 w-full rounded-lg" />
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
    <Link to="/stock" className="inline-flex h-11 items-center gap-1.5 text-sm font-medium text-fg-2 hover:text-fg">
      <ArrowLeft className="size-4" aria-hidden />
      Stock
    </Link>
  )
}

type SheetName = "price" | "move" | "deal" | "damaged" | "remove" | "edit" | null

function ItemView({ item }: { item: InventoryItem }) {
  const toast = useToast()
  const navigate = useNavigate()
  const lookups = useLookups()
  const history = usePriceHistory(item.id)
  const origin = useItemOrigin(item.id)
  const alerts = alertsFor(item)
  const margin = marginPct(item.price, item.cost)
  const tag = variantTag(item)
  const status = STATUS_BADGE[item.status]
  const [sheet, setSheet] = React.useState<SheetName>(null)
  const close = () => setSheet(null)

  const patch = useStockMutation((p: ItemPatch) => updateItem(item.id, p))
  const priced = useStockMutation((changes: { item: string; price: number }[]) => reprice(changes, "manual"))
  const listed = useStockMutation(() => addToPrintList([item]))
  const [printing, setPrinting] = React.useState(false)
  const route = printRoute()

  const save = (p: ItemPatch, done: string, after?: () => void) =>
    patch.mutate(p, {
      onSuccess: () => {
        toast({ message: done, tone: "ok" })
        close()
        after?.()
      },
      onError: (error) => toast({ message: errorText(error, "Not saved. Check the connection and try again."), tone: "alert" }),
    })

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

  const locations = lookups.data?.locations ?? []

  return (
    <section className="pb-8">
      <BackLink />

      <div className="grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] md:gap-8">
        {/* ---------------- hero ---------------- */}
        <header className="flex flex-col items-center text-center md:sticky md:top-6 md:self-start">
          <div className="relative flex w-full justify-center pt-2 pb-6">
            <div
              aria-hidden
              className={cn(
                "pointer-events-none absolute inset-x-[8%] top-[6%] bottom-[2%] rounded-full blur-3xl",
                isCard(item) && tag && tag !== "Normal" ? "bg-accent-violet/15 dark:bg-accent-violet/20" : "bg-volt/15 dark:bg-volt/10"
              )}
            />
            <ItemArt item={item} gyro priority className="w-[64%] max-w-[300px]" />
          </div>

          <p className="label-mono text-fg-3">
            {displayCode(item.sku)} · {KIND_LABEL[item.kind] ?? item.kind}
          </p>
          <h1 className="mt-1 font-display text-[40px] leading-[0.95] tracking-wide text-balance uppercase sm:text-5xl">{item.title}</h1>
          {setLine(item) && <p className="mt-1.5 font-mono text-sm text-fg-2">{setLine(item)}</p>}
          <ul className="mt-3 flex flex-wrap justify-center gap-1.5" aria-label="Variant and condition">
            {tag && (
              <li>
                <Badge tone="violet">{tag}</Badge>
              </li>
            )}
            {item.condition && item.kind === "single" && (
              <li>
                <span
                  className={cn(
                    "inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold",
                    item.condition === "DMG"
                      ? "border-pop/50 bg-pop/10 text-pop-text"
                      : "border-transparent bg-ink text-paper dark:bg-paper dark:text-ink"
                  )}
                >
                  <span className="font-mono">{item.condition}</span>
                  <span className="font-normal opacity-80">{CONDITION_LABEL[item.condition] ?? ""}</span>
                </span>
              </li>
            )}
            {status && (
              <li>
                <Badge tone={status.tone} dot>
                  {status.label}
                </Badge>
              </li>
            )}
            {alerts.map((a) => (
              <li key={a.key}>
                <Badge tone={a.severity === "alert" ? "pop" : a.severity === "warn" ? "warn" : "info"} dot>
                  {a.title}
                </Badge>
              </li>
            ))}
          </ul>
        </header>

        <div className="flex flex-col gap-4">
          {/* ---------------- price tiles ---------------- */}
          <section aria-label="Prices" className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setSheet("price")}
              className="glass col-span-2 flex items-center justify-between gap-3 rounded-lg border border-volt/70 p-4 text-left shadow-panel transition-transform active:scale-[0.99] dark:[box-shadow:var(--glow-volt)]"
              aria-label={`Sticker ${item.price > 0 ? formatGBP(item.price) : "not set"}. Change price.`}
            >
              <span className="min-w-0">
                <span className="label-mono block text-fg-3">Sticker</span>
                {item.price > 0 ? (
                  <Money pence={item.price} size="xl" />
                ) : (
                  <span className="font-display text-4xl text-pop-text uppercase">No price</span>
                )}
                {item.hand_priced && <span className="block text-xs text-fg-3">Last set by hand</span>}
              </span>
              <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-volt text-on-volt">
                <Tag className="size-5" aria-hidden />
              </span>
            </button>
            <Tile label="Cost" note={origin.data?.deal ? "Paid in the deal" : "Each"}>
              {item.cost > 0 ? <Money pence={item.cost} size="lg" /> : <Empty>None</Empty>}
            </Tile>
            <Tile label="Margin" note="On the sticker">
              {margin !== null ? (
                <span className="flex items-center gap-2">
                  <span className="font-mono text-2xl font-bold tnum">{margin}%</span>
                  <Badge tone={marginTone(margin)} className="h-5 px-2">
                    {margin < 10 ? "Thin" : margin < 20 ? "Fair" : "Healthy"}
                  </Badge>
                </span>
              ) : (
                <Empty>None</Empty>
              )}
            </Tile>
            <Tile label={marketLabel(item)} note={item.market_source ? (MARKET_FROM[item.market_source] ?? item.market_source) : "Nothing on file"}>
              {item.market !== null ? <Money pence={item.market} size="lg" /> : <Empty>None</Empty>}
            </Tile>
            <Tile
              label="Value captured"
              note={origin.data?.deal ? "Market when bought in" : origin.data?.market_at_intake ? "At intake" : "Not bought in a deal"}
            >
              {origin.isPending ? (
                <Skeleton className="h-8 w-20" />
              ) : origin.data && origin.data.market_at_intake > 0 ? (
                <Money pence={origin.data.market_at_intake} size="lg" />
              ) : (
                <Empty>None</Empty>
              )}
            </Tile>
          </section>

          {/* ---------------- origin ---------------- */}
          <Block title="Where it came from" icon={<Receipt aria-hidden />}>
            <Origin origin={origin.data} pending={origin.isPending} item={item} />
          </Block>

          {/* ---------------- location and quantity ---------------- */}
          <Block
            title="Location and quantity"
            icon={<MapPin aria-hidden />}
            action={
              <Button size="sm" variant="ghost" icon={<PencilLine className="size-4" aria-hidden />} onClick={() => setSheet("move")}>
                Edit
              </Button>
            }
          >
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <button
                type="button"
                onClick={() => setSheet("move")}
                className="flex min-w-0 items-center gap-3 rounded-md border border-line bg-panel-2 px-3.5 py-3 text-left"
              >
                <span className="min-w-0">
                  <span className="label-mono block text-[10px] text-fg-3">Location</span>
                  <span className={cn("block truncate font-semibold", !item.location_name && "text-warn")}>
                    {item.location_name || "Not shelved"}
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => setSheet("move")}
                className="flex min-w-24 flex-col items-center justify-center rounded-md border border-line bg-panel-2 px-4 py-3"
              >
                <span className="label-mono block text-[10px] text-fg-3">Qty</span>
                <span className="font-mono text-xl font-bold tnum">{item.qty}</span>
              </button>
            </div>
          </Block>

          {/* ---------------- label ---------------- */}
          <Block title="Label" icon={<Printer aria-hidden />}>
            <p className="mb-3 flex items-center gap-2 text-sm">
              <Badge tone={item.label_printed_at ? "ok" : "warn"} dot>
                {item.label_printed_at ? "Printed" : "Not printed"}
              </Badge>
              <span className="text-fg-3">
                {item.label_printed_at ? dateText(item.label_printed_at) : item.price > 0 ? "Ready to print" : "Set a sticker price first"}
              </span>
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Button
                icon={<Printer className="size-4" aria-hidden />}
                loading={printing}
                disabled={item.price <= 0}
                onPointerEnter={() => void loadPrinterLibrary().catch(() => undefined)}
                onClick={print}
              >
                {route === "bluetooth" ? "Print" : "Share label"}
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
          </Block>

          {/* ---------------- Epos Now slot ---------------- */}
          <EposStatus productId={origin.data?.epos_product_id} />

          {/* ---------------- card page ---------------- */}
          {item.card ? (
            <Link
              to="/cards/$id"
              params={{ id: item.card }}
              className="glass group flex items-center gap-3 rounded-lg border border-line p-4 shadow-panel transition-colors hover:border-fg-3"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-ink text-paper dark:bg-paper dark:text-ink">
                <ChartLine className="size-5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">Open card page</span>
                <span className="block truncate text-xs text-fg-3">Price chart, every condition and the grading panel</span>
              </span>
              <ArrowRight className="size-5 text-fg-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </Link>
          ) : null}

          {/* ---------------- price history ---------------- */}
          <Block title="Price history" icon={<History aria-hidden />}>
            <PriceHistory rows={history.data} pending={history.isPending} />
          </Block>

          {/* ---------------- actions ---------------- */}
          <section aria-label="Actions" className="grid grid-cols-2 gap-2">
            <Action icon={<Tag aria-hidden />} label="Change price" onClick={() => setSheet("price")} />
            <Action icon={<MapPin aria-hidden />} label="Move" onClick={() => setSheet("move")} />
            <Action icon={<Handshake aria-hidden />} label="Add to deal" onClick={() => setSheet("deal")} />
            <Action icon={<PencilLine aria-hidden />} label="Edit details" onClick={() => setSheet("edit")} />
            {item.condition !== "DMG" && (
              <Action icon={<ShieldAlert aria-hidden />} label="Mark damaged" tone="warn" onClick={() => setSheet("damaged")} />
            )}
            <Action icon={<Trash2 aria-hidden />} label="Remove from stock" tone="pop" onClick={() => setSheet("remove")} />
          </section>
        </div>
      </div>

      {/* ---------------- sheets ---------------- */}
      <ChangePriceSheet
        open={sheet === "price"}
        onClose={close}
        items={[item]}
        busy={priced.isPending}
        onApply={(changes) =>
          priced.mutate(changes, {
            onSuccess: () => {
              toast({
                message: item.label_printed_at ? "Price changed. The label is on the print list to reprint." : "Price changed.",
                tone: "ok",
              })
              close()
            },
            onError: (error) => toast({ message: errorText(error, "The price was not changed. Try again."), tone: "alert" }),
          })
        }
      />
      <MoveSheet
        open={sheet === "move"}
        onClose={close}
        item={item}
        locations={locations}
        busy={patch.isPending}
        onSave={(p) => {
          const name = p.location !== undefined ? (locations.find((l) => l.id === p.location)?.name ?? "Not shelved") : ""
          save(p, p.location !== undefined ? `Moved to ${name}.` : "Quantity saved.")
        }}
      />
      <EditDetailsSheet open={sheet === "edit"} onClose={close} item={item} busy={patch.isPending} onSave={(p) => save(p, "Saved.")} />
      <AddToDealSheet open={sheet === "deal"} onClose={close} item={item} />
      <ConfirmSheet
        open={sheet === "damaged"}
        onClose={close}
        title="Mark damaged"
        description={item.title}
        confirm="Mark damaged"
        busy={patch.isPending}
        onConfirm={() => save({ condition: "DMG" }, "Marked damaged.")}
      >
        <p>The condition changes to DMG and the market value drops to the damaged price. The sticker stays as it is, so check it after.</p>
      </ConfirmSheet>
      <ConfirmSheet
        open={sheet === "remove"}
        onClose={close}
        title="Remove from stock"
        description={`${displayCode(item.sku)}, ${item.title}`}
        confirm="Remove"
        danger
        busy={patch.isPending}
        onConfirm={() =>
          save(
            {
              status: "written_off",
              notes: [item.notes, `Removed from stock ${new Date().toLocaleDateString("en-GB")}.`].filter(Boolean).join(" "),
            },
            "Removed from stock.",
            () => navigate({ to: "/stock" })
          )
        }
      >
        <p>It comes off the shelf count and out of the inventory list. The record, its deal and its price history stay on file.</p>
        {item.qty > 1 && <p className="font-semibold text-fg">All {item.qty} on this line come off. To take off fewer, change the quantity instead.</p>}
        <p>Use this for lost or binned stock. A sale goes through the till instead.</p>
      </ConfirmSheet>
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <span className="text-lg text-fg-3">{children}</span>
}

function Tile({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="glass flex min-w-0 flex-col gap-1 rounded-lg border border-line p-3.5 shadow-panel">
      <p className="label-mono truncate text-[10px] text-fg-3">{label}</p>
      <div className="flex min-h-8 items-center">{children}</div>
      {note && <p className="truncate text-xs text-fg-3">{note}</p>}
    </div>
  )
}

function Block({
  title,
  icon,
  action,
  children,
}: {
  title: string
  icon: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="glass rounded-lg border border-line p-4 shadow-panel">
      <div className="mb-3 flex min-h-9 items-center justify-between gap-2">
        <h2 className="label-mono flex items-center gap-2 text-fg-2 [&_svg]:size-4">
          {icon}
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function Action({
  icon,
  label,
  onClick,
  tone,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  tone?: "warn" | "pop"
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "glass flex min-h-14 items-center gap-2.5 rounded-md border border-line px-3.5 text-left text-sm font-semibold shadow-panel transition-[transform,border-color] active:scale-[0.98] [&_svg]:size-[18px] [&_svg]:shrink-0",
        tone === "warn" && "text-warn",
        tone === "pop" && "border-pop/30 text-pop-text"
      )}
    >
      {icon}
      {label}
    </button>
  )
}

function Origin({ origin, pending, item }: { origin: ItemOrigin | undefined; pending: boolean; item: InventoryItem }) {
  if (pending) return <Skeleton lines={2} />
  const deal = origin?.deal
  if (deal) {
    const when = dateText(deal.completed_at || deal.created)
    return (
      <div className="flex flex-col gap-3">
        <Link
          to="/deals/$id"
          params={{ id: deal.id }}
          className="flex items-center gap-3 rounded-md border border-line bg-panel-2 px-3.5 py-3 transition-colors hover:border-fg-3"
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-volt text-on-volt">
            <Handshake className="size-5" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-mono font-bold">{deal.number || "Deal"}</span>
            <span className="block text-xs text-fg-3">Bought in on {when}</span>
          </span>
          <ArrowRight className="size-4 text-fg-3" aria-hidden />
        </Link>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="text-fg-3">Price paid</dt>
          <dd className="text-right">
            {item.cost > 0 ? <Money pence={item.cost} className="font-semibold" /> : "None recorded"}
            {item.qty > 1 && <span className="text-fg-3"> each</span>}
          </dd>
          {deal.line_offer > 0 && deal.line_qty > 1 && (
            <>
              <dt className="text-fg-3">Deal line</dt>
              <dd className="text-right">
                <Money pence={deal.line_offer} className="font-semibold" /> for {deal.line_qty}
              </dd>
            </>
          )}
          {deal.payout_type && (
            <>
              <dt className="text-fg-3">Paid as</dt>
              <dd className="text-right capitalize">{deal.payout_type === "mixed" ? "Cash and credit" : deal.payout_type}</dd>
            </>
          )}
        </dl>
      </div>
    )
  }
  const added = dateText(origin?.acquired_at || item.acquired_at || item.created)
  const how =
    origin?.source === "supplier"
      ? `Supplier${origin.supplier_ref ? `, ${origin.supplier_ref}` : ""}`
      : origin?.source === "opening_stock"
        ? "Opening stock"
        : origin?.source === "trade_in"
          ? "A buy-in from before deals"
          : "Added by hand"
  return (
    <div className="flex items-center gap-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-line text-fg-2">
        <Truck className="size-5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{how}</span>
        <span className="block text-xs text-fg-3">
          {added ? `Added ${added}` : "Date not recorded"}
          {item.cost > 0 ? `, cost ${formatGBP(item.cost)}` : ""}
        </span>
      </span>
    </div>
  )
}

function PriceHistory({ rows, pending }: { rows: PriceChange[] | undefined; pending: boolean }) {
  if (pending) return <Skeleton lines={2} />
  if (!rows || rows.length === 0) {
    return <p className="text-sm text-fg-3">No price changes yet. Changes made here, in bulk or by a pricing rule show up here.</p>
  }
  return (
    <ol className="relative flex flex-col">
      {rows.map((h, i) => {
        const up = h.new_price > h.old_price
        const diff = h.new_price - h.old_price
        return (
          <li key={h.id} className="relative flex items-center gap-3 py-2.5 pl-6 text-sm">
            <span aria-hidden className={cn("absolute top-0 bottom-0 left-[7px] w-px bg-line-2", i === 0 && "top-1/2", i === rows.length - 1 && "bottom-1/2")} />
            <span
              aria-hidden
              className={cn(
                "absolute left-0.5 size-3 rounded-full border-2 border-bg-2",
                i === 0 ? "bg-volt" : "bg-fg-3"
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="block">{dateText(h.created)}</span>
              <span className="block truncate text-xs text-fg-3">
                {SOURCE_LABEL[h.source] ?? h.source}
                {h.expand?.staff?.name ? `, ${h.expand.staff.name}` : ""}
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end">
              <span className="flex items-baseline gap-1.5">
                {h.old_price > 0 && <Money pence={h.old_price} size="sm" tone="muted" className="line-through decoration-fg-3/60" />}
                <Money pence={h.new_price} className="font-bold" />
              </span>
              {h.old_price === 0 ? (
                <span className="font-mono text-[11px] text-fg-3">First price</span>
              ) : diff !== 0 && (
                <span className={cn("flex items-center gap-0.5 font-mono text-[11px] tnum", up ? "text-ok" : "text-pop-text")}>
                  {up ? <ArrowUpRight className="size-3" aria-hidden /> : <ArrowDownRight className="size-3" aria-hidden />}
                  {up ? "+" : "-"}
                  {formatGBP(Math.abs(diff))}
                </span>
              )}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
