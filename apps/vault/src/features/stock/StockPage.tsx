import * as React from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { AnimatePresence, motion } from "motion/react"
import { BookOpen, CheckSquare, List, MapPin, Package, Plus, Printer, Search, SlidersHorizontal, Tag, X } from "lucide-react"
import { displayCode } from "@gg/shared/sku"

import { cn } from "@/lib/cn"
import { Badge, Button, buttonClasses, EmptyState, IconButton, Input, Money, PageHeader, Segmented, Sheet, Skeleton, useToast } from "@/ui"

import { addToPrintList, errorText, moveItems, reprice, useInventory, useLookups, useStockMutation } from "./api"
import { ChangePriceSheet } from "./components/ChangePriceSheet"
import { BinderGrid } from "./components/BinderGrid"
import { ItemArt } from "./components/ItemArt"
import { QuickViewSheet } from "./components/QuickViewSheet"
import { healthRule } from "./health/health"
import { SelectField } from "./components/SelectField"
import { StatTile } from "./components/StatTile"
import { StockNav } from "./components/StockNav"
import {
  DEFAULT_FILTERS,
  detailLine,
  filterItems,
  marginPct,
  SORTS,
  STOCK_TABS,
  summarise,
  tabOf,
  type SortKey,
  type StockFilters,
} from "./lib/inventory"
import { marginTone, variantTag } from "./lib/item-view"
import { CONDITIONS, type InventoryItem } from "./types"

const PAGE = 60
const VIEW_KEY = "gg-vault-stock-view"

export type StockView = "list" | "binder"

function savedView(): StockView {
  try {
    return localStorage.getItem(VIEW_KEY) === "binder" ? "binder" : "list"
  } catch {
    return "list"
  }
}

export interface StockSearch {
  q?: string
  /** A health alert key: only the items it flags. */
  alert?: string
}

export function StockPage({ search = {} }: { search?: StockSearch }) {
  const inventory = useInventory()
  const lookups = useLookups()
  const navigate = useNavigate()
  const toast = useToast()

  const [filters, setFilters] = React.useState<StockFilters>({ ...DEFAULT_FILTERS, q: search.q ?? "" })
  const [filtersOpen, setFiltersOpen] = React.useState(false)
  const [selecting, setSelecting] = React.useState(false)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [sheet, setSheet] = React.useState<"price" | "move" | null>(null)
  const [moveTo, setMoveTo] = React.useState("")
  const [shown, setShown] = React.useState(PAGE)
  const [view, setViewState] = React.useState<StockView>(savedView)
  const [quick, setQuick] = React.useState<InventoryItem | null>(null)
  const [quickOpen, setQuickOpen] = React.useState(false)

  const setView = (next: StockView) => {
    setViewState(next)
    try {
      localStorage.setItem(VIEW_KEY, next)
    } catch {
      // Private browsing: the choice lasts for this visit only.
    }
  }
  const openQuick = (item: InventoryItem) => {
    setQuick(item)
    setQuickOpen(true)
  }

  const all = React.useMemo(() => inventory.data ?? [], [inventory.data])
  const alert = search.alert ? healthRule(search.alert) : undefined
  const scoped = React.useMemo(() => (alert ? all.filter(alert.test) : all), [all, alert])
  const rows = React.useMemo(() => filterItems(scoped, filters), [scoped, filters])
  const summary = React.useMemo(() => summarise(rows), [rows])
  const tabCounts = React.useMemo(() => {
    const counts: Record<string, number> = { all: scoped.length }
    for (const item of scoped) counts[tabOf(item)] = (counts[tabOf(item)] ?? 0) + 1
    return counts
  }, [scoped])

  const set = <K extends keyof StockFilters>(key: K, value: StockFilters[K]) => {
    setFilters((now) => ({ ...now, [key]: value }))
    setShown(PAGE)
  }

  const chosen = rows.filter((row) => selected.has(row.id))
  const toggle = (id: string) =>
    setSelected((now) => {
      const next = new Set(now)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const stopSelecting = () => {
    setSelecting(false)
    setSelected(new Set())
  }

  const printList = useStockMutation((items: InventoryItem[]) => addToPrintList(items))
  const bulkPrice = useStockMutation((changes: { item: string; price: number }[]) => reprice(changes, "bulk"))
  const move = useStockMutation(({ ids, location }: { ids: string[]; location: string }) => moveItems(ids, location))

  const activeFilters = [
    filters.game && { key: "game" as const, label: lookups.data?.games.find((g) => g.id === filters.game)?.name ?? "Game" },
    filters.condition && { key: "condition" as const, label: filters.condition },
    filters.location && {
      key: "location" as const,
      label: lookups.data?.locations.find((l) => l.id === filters.location)?.name ?? "Location",
    },
  ].filter(Boolean) as { key: "game" | "condition" | "location"; label: string }[]

  return (
    <section className={cn(selecting && chosen.length > 0 && "pb-24")}>
      <PageHeader
        eyebrow="Inventory"
        title="Stock"
        actions={
          <Link to="/stock/new" className={buttonClasses("primary", "md")} aria-label="Add stock">
            <Plus className="size-5" aria-hidden />
            <span className="max-sm:hidden">Add stock</span>
            <span className="sm:hidden">Add</span>
          </Link>
        }
      />
      <StockNav />

      <div className="mb-5 grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <StatTile label="Items" count={summary.units} note={`${summary.rows.toLocaleString("en-GB")} lines`} />
        <StatTile
          label="Market value"
          pence={summary.market}
          accent
          note={summary.unpriced ? `${summary.unpriced} units have none` : "UK prices first"}
        />
        <StatTile label="Sticker value" pence={summary.sticker} note="What it is priced at" />
        <StatTile
          label="Cost value"
          pence={summary.cost}
          note={summary.sticker > 0 ? `${marginPct(summary.sticker, summary.cost) ?? 0}% margin on sticker` : "What we paid"}
        />
      </div>

      {alert && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-pop/40 bg-pop/10 px-3.5 py-2.5 text-sm">
          <span>
            Showing {scoped.length} {scoped.length === 1 ? "item" : "items"} flagged <strong>{alert.title.toLowerCase()}</strong>
          </span>
          <Link to="/stock" className="font-semibold underline underline-offset-2">
            Show all
          </Link>
        </div>
      )}

      <div role="tablist" aria-label="Stock type" className="-mx-4 mb-3 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:px-0">
        <div className="flex w-max gap-1 border-b border-line">
          {STOCK_TABS.map((tab) => {
            const active = filters.tab === tab.value
            return (
              <button
                key={tab.value}
                role="tab"
                aria-selected={active}
                onClick={() => set("tab", tab.value)}
                className={cn(
                  "relative flex h-11 items-center gap-1.5 px-3 text-[15px] font-medium transition-colors",
                  active ? "text-fg" : "text-fg-3 hover:text-fg"
                )}
              >
                {tab.label}
                <span className="font-mono text-[11px] text-fg-3 tnum">{tabCounts[tab.value] ?? 0}</span>
                {active && (
                  <motion.span layoutId="stock-tab" className="absolute inset-x-2 -bottom-px h-[3px] rounded-full bg-volt" />
                )}
              </button>
            )
          })}
        </div>
      </div>

      <div className="mb-3 flex gap-2">
        <Input
          aria-label="Search stock"
          className="flex-1"
          placeholder="Name, SKU, set or location"
          leading={<Search aria-hidden />}
          value={filters.q}
          onChange={(event) => set("q", event.target.value)}
          trailing={
            filters.q ? (
              <button type="button" aria-label="Clear search" onClick={() => set("q", "")} className="p-1">
                <X className="size-4" aria-hidden />
              </button>
            ) : undefined
          }
        />
        <IconButton label="Filters and sort" variant="secondary" onClick={() => setFiltersOpen(true)} className="size-12 shrink-0">
          <SlidersHorizontal aria-hidden />
        </IconButton>
        <IconButton
          label={selecting ? "Stop selecting" : "Select items"}
          variant={selecting ? "primary" : "secondary"}
          onClick={() => {
            if (selecting) return stopSelecting()
            // Picking items is a list job; the binder is for looking.
            setView("list")
            setSelecting(true)
          }}
          className="size-12 shrink-0"
        >
          <CheckSquare aria-hidden />
        </IconButton>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        {!selecting && (
          <Segmented
            label="Stock view"
            size="sm"
            value={view}
            onChange={setView}
            className="order-last ml-auto"
            options={[
              { value: "list", label: "List", icon: <List className="size-4" aria-hidden /> },
              { value: "binder", label: "Binder", icon: <BookOpen className="size-4" aria-hidden /> },
            ]}
          />
        )}
        <span className="text-fg-3">
          {rows.length.toLocaleString("en-GB")} {rows.length === 1 ? "line" : "lines"}, {SORTS.find((s) => s.value === filters.sort)?.label.toLowerCase()} first
        </span>
        {activeFilters.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => set(f.key, "")}
            className="inline-flex h-7 items-center gap-1 rounded-full bg-ink px-2.5 text-xs font-medium text-paper dark:bg-paper dark:text-ink"
            aria-label={`Remove filter ${f.label}`}
          >
            {f.label}
            <X className="size-3.5" aria-hidden />
          </button>
        ))}
        {selecting && (
          <button
            type="button"
            className="ml-auto text-sm font-semibold underline underline-offset-2"
            onClick={() => setSelected(chosen.length === rows.length ? new Set() : new Set(rows.map((r) => r.id)))}
          >
            {chosen.length === rows.length && rows.length > 0 ? "Select none" : "Select all"}
          </button>
        )}
      </div>

      {inventory.isPending ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-[76px] rounded-lg" />
          ))}
        </div>
      ) : inventory.isError ? (
        <EmptyState icon={<Package aria-hidden />} title="Stock did not load">
          {errorText(inventory.error, "The server did not answer. Check the connection, then pull to refresh.")}
          <div className="mt-3">
            <Button variant="secondary" onClick={() => inventory.refetch()}>
              Try again
            </Button>
          </div>
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Package aria-hidden />}
          title={all.length === 0 ? "No stock yet" : "Nothing matches"}
          action={
            all.length === 0 ? (
              <Link to="/stock/new" className={buttonClasses("primary")}>
                Add stock
              </Link>
            ) : (
              <Button variant="secondary" onClick={() => setFilters({ ...DEFAULT_FILTERS })}>
                Clear filters
              </Button>
            )
          }
        >
          {all.length === 0 ? "Add an item or import a CSV and it shows up here." : "Try the SKU, or clear the filters."}
        </EmptyState>
      ) : view === "binder" && !selecting ? (
        <BinderGrid items={rows.slice(0, Math.ceil(shown / 9) * 9)} onOpen={openQuick} />
      ) : (
        <ul className="glass divide-y divide-line overflow-hidden rounded-lg border border-line shadow-panel">
          {rows.slice(0, shown).map((item) => (
            <StockRow
              key={item.id}
              item={item}
              selecting={selecting}
              selected={selected.has(item.id)}
              onToggle={() => toggle(item.id)}
              onOpen={() => openQuick(item)}
            />
          ))}
        </ul>
      )}
      {rows.length > (view === "binder" && !selecting ? Math.ceil(shown / 9) * 9 : shown) && (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" onClick={() => setShown((n) => n + PAGE)}>
            Show {Math.min(PAGE, rows.length - shown)} more
          </Button>
        </div>
      )}

      <AnimatePresence>
        {selecting && chosen.length > 0 && (
          <motion.div
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 80, opacity: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 36 }}
            className="fixed inset-x-0 bottom-[calc(var(--tabbar-h)+var(--safe-bottom)+10px)] z-30 px-3 md:bottom-6 md:pl-[100px] lg:pl-[232px]"
          >
            <div className="mx-auto flex max-w-3xl items-center gap-2 rounded-lg border border-line-2 bg-ink p-2 pl-4 text-paper shadow-sheet dark:bg-bg-2 dark:text-fg">
              <span className="font-mono text-sm font-bold tnum whitespace-nowrap">{chosen.length} selected</span>
              <div className="ml-auto flex gap-1.5">
                <ActionButton
                  icon={<Printer aria-hidden />}
                  label="Print list"
                  loading={printList.isPending}
                  onClick={() =>
                    printList.mutate(chosen, {
                      onSuccess: (n) => {
                        toast({ message: `${n} added to the print list.`, tone: "ok" })
                        stopSelecting()
                      },
                      onError: (error) => toast({ message: errorText(error, "Could not add them. Try again."), tone: "alert" }),
                    })
                  }
                />
                <ActionButton icon={<Tag aria-hidden />} label="Price" onClick={() => setSheet("price")} />
                <ActionButton icon={<MapPin aria-hidden />} label="Move" onClick={() => setSheet("move")} />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <QuickViewSheet
        item={quick}
        open={quickOpen}
        onClose={() => setQuickOpen(false)}
        onOpenItem={(item) => {
          setQuickOpen(false)
          navigate({ to: "/stock/$id", params: { id: item.sku } })
        }}
      />

      <Sheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title="Filter and sort"
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" block onClick={() => setFilters((f) => ({ ...DEFAULT_FILTERS, q: f.q, tab: f.tab }))}>
              Clear
            </Button>
            <Button block onClick={() => setFiltersOpen(false)}>
              Show {rows.length.toLocaleString("en-GB")}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4 pt-2">
          <SelectField
            label="Sort"
            value={filters.sort}
            onChange={(v) => set("sort", v as SortKey)}
            options={SORTS}
          />
          <SelectField
            label="Game"
            value={filters.game}
            onChange={(v) => set("game", v)}
            placeholder="Any game"
            options={(lookups.data?.games ?? []).map((g) => ({ value: g.id, label: g.name }))}
          />
          <SelectField
            label="Condition"
            value={filters.condition}
            onChange={(v) => set("condition", v)}
            placeholder="Any condition"
            options={CONDITIONS.map((c) => ({ value: c, label: c }))}
          />
          <SelectField
            label="Location"
            value={filters.location}
            onChange={(v) => set("location", v)}
            placeholder="Anywhere"
            options={(lookups.data?.locations ?? []).map((l) => ({ value: l.id, label: l.name }))}
          />
        </div>
      </Sheet>

      <ChangePriceSheet
        open={sheet === "price"}
        onClose={() => setSheet(null)}
        items={chosen}
        busy={bulkPrice.isPending}
        onApply={(changes) =>
          bulkPrice.mutate(changes, {
            onSuccess: (res) => {
              toast({ message: `${res.changed} ${res.changed === 1 ? "price" : "prices"} changed.`, tone: "ok" })
              setSheet(null)
              stopSelecting()
            },
            onError: (error) => toast({ message: errorText(error, "The prices were not changed. Try again."), tone: "alert" }),
          })
        }
      />

      <Sheet
        open={sheet === "move"}
        onClose={() => setSheet(null)}
        title="Move location"
        description={`${chosen.length} ${chosen.length === 1 ? "item" : "items"}`}
        footer={
          <Button
            block
            size="lg"
            disabled={!moveTo}
            loading={move.isPending}
            onClick={() =>
              move.mutate(
                { ids: chosen.map((c) => c.id), location: moveTo },
                {
                  onSuccess: () => {
                    const name = lookups.data?.locations.find((l) => l.id === moveTo)?.name ?? "the new location"
                    toast({ message: `Moved to ${name}.`, tone: "ok" })
                    setSheet(null)
                    stopSelecting()
                  },
                  onError: (error) => toast({ message: errorText(error, "Not moved. Try again."), tone: "alert" }),
                }
              )
            }
          >
            Move {chosen.length}
          </Button>
        }
      >
        <div className="pt-2">
          <SelectField
            label="New location"
            value={moveTo}
            onChange={setMoveTo}
            placeholder="Choose a location"
            options={(lookups.data?.locations ?? []).map((l) => ({ value: l.id, label: l.name }))}
          />
        </div>
      </Sheet>
    </section>
  )
}

function ActionButton({
  icon,
  label,
  onClick,
  loading,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  loading?: boolean
}) {
  return (
    <Button size="sm" variant="primary" icon={icon} onClick={onClick} loading={loading} className="h-10 px-3 [&_svg]:size-4">
      {label}
    </Button>
  )
}

function StockRow({
  item,
  selecting,
  selected,
  onToggle,
  onOpen,
}: {
  item: InventoryItem
  selecting: boolean
  selected: boolean
  onToggle: () => void
  onOpen: () => void
}) {
  const margin = marginPct(item.price, item.cost)
  const tone = marginTone(margin)
  const detail = detailLine(item)
  return (
    <li>
      <button
        type="button"
        onClick={selecting ? onToggle : onOpen}
        aria-pressed={selecting ? selected : undefined}
        className={cn(
          "flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-line/50 active:bg-line",
          selected && "bg-volt/15 hover:bg-volt/20"
        )}
      >
        {selecting && (
          <span
            aria-hidden
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-[6px] border-2 transition-colors",
              selected ? "border-volt bg-volt text-on-volt" : "border-line-2"
            )}
          >
            {selected && (
              <svg viewBox="0 0 16 16" className="size-3.5">
                <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
              </svg>
            )}
          </span>
        )}
        <ItemArt item={item} tilt={false} glow={false} className="w-12 shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[15px] leading-tight font-semibold">{item.title}</span>
          <span className="truncate font-mono text-[11px] text-fg-3">
            {displayCode(item.sku)}
            {detail && ` · ${detail}`}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 [&>span]:shrink-0 [&>span]:whitespace-nowrap">
            {item.condition && item.kind === "single" && <Badge className="h-5 px-2">{item.condition}</Badge>}
            {variantTag(item) && item.kind !== "graded" && variantTag(item) !== "Normal" && (
              <Badge tone="violet" className="h-5 px-2">
                {variantTag(item)}
              </Badge>
            )}
            {item.qty > 1 && <Badge tone="info" className="h-5 px-2">Qty {item.qty}</Badge>}
            {item.location_name && <span className="min-w-0 !shrink truncate text-xs text-fg-3">{item.location_name}</span>}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5">
          {item.price > 0 ? (
            <Money pence={item.price} className="text-[15px] font-bold" />
          ) : (
            <span className="text-sm font-semibold text-pop-text">No price</span>
          )}
          <span className="font-mono text-[11px] text-fg-3 tnum">
            {item.cost > 0 ? <Money pence={item.cost} className="text-[11px] text-fg-3" /> : "No cost"}
          </span>
          {margin !== null && (
            <Badge tone={tone} className="h-5 px-2" aria-label={`Margin ${margin}%`}>
              {margin}%
            </Badge>
          )}
        </span>
      </button>
    </li>
  )
}
