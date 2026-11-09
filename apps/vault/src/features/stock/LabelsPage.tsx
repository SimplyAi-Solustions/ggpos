import * as React from "react"
import { Link } from "@tanstack/react-router"
import { Bluetooth, BluetoothConnected, Printer, RotateCcw, Share, Trash2 } from "lucide-react"
import { displayCode } from "@gg/shared/sku"

import { cn } from "@/lib/cn"
import { Badge, Button, buttonClasses, Card, EmptyState, IconButton, Money, PageHeader, Segmented, Skeleton, useToast } from "@/ui"

import {
  errorText,
  markPrinted,
  removeFromPrintList,
  setPrintStatus,
  useInventory,
  usePrintList,
  useStockMutation,
  type PrintEntry,
  type PrintStatus,
} from "./api"
import { ItemThumb } from "./components/ItemThumb"
import { SelectField } from "./components/SelectField"
import { StockNav } from "./components/StockNav"
import { PRICE_LABEL_SIZES, type PriceLabelSizeKey } from "./labels/layout"
import { connectLabelPrinter, loadPrinterLibrary, useLabelPrinter, type Darkness } from "./labels/niimbot"
import { MAX_COPIES, printLabelText } from "./labels/plan"
import { printPriceLabels, printRoute } from "./labels/print"
import { saveDarkness, saveLabelSize, savedDarkness, savedLabelSize } from "./labels/settings"
import type { InventoryItem } from "./types"

const TABS: { value: PrintStatus; label: string }[] = [
  { value: "to_print", label: "To print" },
  { value: "needs_reprint", label: "Reprint" },
  { value: "printed", label: "Printed" },
]

interface Row {
  entry: PrintEntry
  item: InventoryItem
}

export function LabelsPage() {
  const toast = useToast()
  const list = usePrintList()
  const inventory = useInventory()
  const printer = useLabelPrinter()
  const route = printRoute()
  const [tab, setTab] = React.useState<PrintStatus>("to_print")
  const [copies, setCopies] = React.useState<Record<string, number>>({})
  const [size, setSize] = React.useState<PriceLabelSizeKey>(savedLabelSize())
  const [darkness, setDarkness] = React.useState<Darkness>(savedDarkness())
  const [busy, setBusy] = React.useState(false)

  const byId = React.useMemo(() => new Map((inventory.data ?? []).map((i) => [i.id, i])), [inventory.data])
  const rows: Row[] = React.useMemo(
    () =>
      (list.data ?? [])
        .map((entry) => ({ entry, item: byId.get(entry.item) }))
        .filter((r): r is Row => Boolean(r.item)),
    [list.data, byId]
  )
  const counts = Object.fromEntries(TABS.map((t) => [t.value, rows.filter((r) => r.entry.status === t.value).length]))
  const shown = rows.filter((r) => r.entry.status === tab)
  const printable = shown.filter((r) => r.item.price > 0)
  const countOf = (r: Row) => copies[r.entry.id] ?? (r.entry.copies || 1)
  const total = printable.reduce((sum, r) => sum + countOf(r), 0)

  const remove = useStockMutation((entries: PrintEntry[]) => removeFromPrintList(entries))
  const requeue = useStockMutation((entries: PrintEntry[]) => setPrintStatus(entries, "to_print"))
  const done = useStockMutation((entries: PrintEntry[]) => markPrinted(entries))

  const printAll = async () => {
    setBusy(true)
    try {
      const result = await printPriceLabels(
        printable.map((r) => ({ sku: r.item.sku, title: r.item.title, price: r.item.price, copies: countOf(r) }))
      )
      if (result.count > 0) {
        await done.mutateAsync(printable.map((r) => r.entry))
        toast({
          message: result.route === "bluetooth" ? `${result.count} labels printed.` : `${result.count} label images ready. Print them from the NIIMBOT app.`,
          tone: "ok",
          duration: 6000,
        })
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return
      toast({ message: errorText(error, "The labels did not print. Try again."), tone: "alert", duration: 9000 })
    } finally {
      setBusy(false)
    }
  }

  const loading = list.isPending || inventory.isPending

  return (
    <section className="pb-6">
      <PageHeader eyebrow="Inventory" title="Labels">
        Price labels for the Niimbot D110. Pick items on Stock and press Print list.
      </PageHeader>
      <StockNav />

      <Card className="mb-4 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-full [&_svg]:size-5",
              printer.status === "connected" || printer.status === "printing" ? "bg-volt text-on-volt" : "bg-panel-2 text-fg-2"
            )}
          >
            {route === "bluetooth" ? printer.status === "connected" ? <BluetoothConnected aria-hidden /> : <Bluetooth aria-hidden /> : <Share aria-hidden />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              {route !== "bluetooth"
                ? "Share to the NIIMBOT app"
                : printer.status === "connected" || printer.status === "printing"
                  ? printer.name
                  : "D110 not connected"}
            </p>
            <p className="text-sm text-fg-3">
              {route !== "bluetooth"
                ? "This browser has no Bluetooth. Labels open in the share sheet as images."
                : printer.status === "printing"
                  ? "Printing"
                  : printer.status === "connected"
                    ? "Ready"
                    : "Connects on the first print, or now."}
            </p>
          </div>
          {route === "bluetooth" && printer.status !== "connected" && printer.status !== "printing" && (
            <Button
              size="sm"
              variant="secondary"
              loading={printer.status === "connecting"}
              onPointerEnter={() => void loadPrinterLibrary().catch(() => undefined)}
              onClick={() => connectLabelPrinter().catch((error) => toast({ message: errorText(error, "Not connected."), tone: "alert", duration: 9000 }))}
            >
              Connect
            </Button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <SelectField
            label="Roll"
            value={size}
            onChange={(v) => {
              setSize(v as PriceLabelSizeKey)
              saveLabelSize(v as PriceLabelSizeKey)
            }}
            options={PRICE_LABEL_SIZES.map((s) => ({ value: s.key, label: s.name }))}
          />
          <SelectField
            label="Darkness"
            value={darkness}
            onChange={(v) => {
              setDarkness(v as Darkness)
              saveDarkness(v as Darkness)
            }}
            options={[
              { value: "light", label: "Light" },
              { value: "normal", label: "Normal" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </div>
      </Card>

      <Segmented
        label="Print list"
        block
        size="sm"
        className="mb-3"
        value={tab}
        onChange={setTab}
        options={TABS.map((t) => ({ value: t.value, label: `${t.label} ${counts[t.value] ?? 0}` }))}
      />

      {loading ? (
        <Skeleton className="h-48 rounded-lg" />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={<Printer aria-hidden />}
          title={tab === "to_print" ? "Nothing to print" : tab === "needs_reprint" ? "No reprints" : "Nothing printed yet"}
          action={
            tab === "to_print" ? (
              <Link to="/stock" className={buttonClasses("secondary")}>
                Pick items on Stock
              </Link>
            ) : undefined
          }
        >
          {tab === "needs_reprint"
            ? "A printed item whose price changes lands here."
            : tab === "to_print"
              ? "Select items on Stock, then press Print list. New stock lands here too."
              : "Labels printed from this list show here."}
        </EmptyState>
      ) : (
        <>
          <ul className="glass divide-y divide-line overflow-hidden rounded-lg border border-line shadow-panel">
            {shown.map((r) => (
              <li key={r.entry.id} className="flex gap-3 px-3 py-3">
                <ItemThumb item={r.item} className="w-11" />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <Link to="/stock/$id" params={{ id: r.item.sku }} className="truncate font-semibold hover:underline">
                    {r.item.title}
                  </Link>
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 flex-col">
                      {r.item.price > 0 ? <Money pence={r.item.price} size="sm" className="font-bold" /> : <Badge tone="pop">No price</Badge>}
                      <span className="truncate font-mono text-[11px] text-fg-3">{displayCode(r.item.sku)}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {tab === "printed" ? (
                        <IconButton label={`Reprint ${r.item.title}`} variant="secondary" size="sm" onClick={() => requeue.mutate([r.entry])}>
                          <RotateCcw aria-hidden />
                        </IconButton>
                      ) : (
                        <CopiesStepper value={countOf(r)} onChange={(n) => setCopies((c) => ({ ...c, [r.entry.id]: n }))} label={r.item.title} />
                      )}
                      <IconButton label={`Remove ${r.item.title}`} size="sm" onClick={() => remove.mutate([r.entry])}>
                        <Trash2 aria-hidden />
                      </IconButton>
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {tab !== "printed" && (
            <div className="sticky bottom-[calc(var(--tabbar-h)+var(--safe-bottom)+10px)] mt-4 md:bottom-4">
              <Button
                size="lg"
                block
                loading={busy}
                disabled={total === 0}
                icon={route === "bluetooth" ? <Printer className="size-5" aria-hidden /> : <Share className="size-5" aria-hidden />}
                onPointerEnter={() => void loadPrinterLibrary().catch(() => undefined)}
                onClick={printAll}
              >
                {route === "bluetooth" ? printLabelText(total) : `Share ${printable.length} label ${printable.length === 1 ? "image" : "images"}`}
              </Button>
              {printable.length < shown.length && (
                <p className="mt-2 text-center text-sm text-fg-3">{shown.length - printable.length} with no price are skipped.</p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}

function CopiesStepper({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  return (
    <div className="flex items-center rounded-full border border-line-2 bg-panel-2" role="group" aria-label={`Copies of ${label}`}>
      <button type="button" aria-label="One fewer" className="flex size-9 items-center justify-center text-lg" onClick={() => onChange(Math.max(1, value - 1))}>
        -
      </button>
      <span className="w-6 text-center font-mono text-sm font-bold tnum">{value}</span>
      <button type="button" aria-label="One more" className="flex size-9 items-center justify-center text-lg" onClick={() => onChange(Math.min(MAX_COPIES, value + 1))}>
        +
      </button>
    </div>
  )
}
