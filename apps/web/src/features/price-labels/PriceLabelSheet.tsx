/**
 * Print price: the sheet the item page, the stock list and Add stock open to
 * put price labels through the Niimbot D110 on the counter Mac.
 *
 * It shows the label as it will print, one row per item with how many to
 * print, the roll and the darkness (remembered by this browser, because the
 * printer belongs to the machine and not to the shop), and where the printer
 * has got to in words. The one black block prints; if no printer is
 * connected yet the same press shows Chrome's list first, so the very first
 * label of the day is one click and one choice.
 */
import * as React from "react"
import { displayCode, formatGBP } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Field, FieldError } from "@/components/ui/field"
import { Hint, MicroLabel } from "@/components/ui/micro-label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Stepper } from "@/features/stock/Stepper"

import {
  DEFAULT_PRICE_LABEL_SIZE,
  PRICE_LABEL_SIZES,
  priceLabelSize,
  type PriceLabelSizeKey,
} from "./layout"
import {
  bluetoothSupported,
  connectLabelPrinter,
  describeLabelPrinterError,
  LABEL_PRINTER_MESSAGES,
  loadPrinterLibrary,
  printLabels,
  useLabelPrinter,
  type Darkness,
  type LabelPrinterState,
} from "./niimbot"
import {
  hasPrice,
  MAX_COPIES,
  printableRows,
  printLabelText,
  remainingAfter,
  totalLabels,
  type PriceLabelItem,
} from "./plan"

export type { PriceLabelItem } from "./plan"

const SIZE_KEY = "gg-price-label-size"
const DARKNESS_KEY = "gg-price-label-darkness"

const DARKNESS: { value: Darkness; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "normal", label: "Normal" },
  { value: "dark", label: "Dark" },
]

function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeSetting(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // A private window keeps the choice for this sheet only.
  }
}

function isDarkness(value: string | null): value is Darkness {
  return value === "light" || value === "normal" || value === "dark"
}

/** Where the printer has got to, in one line. */
function printerLine(printer: LabelPrinterState): string {
  switch (printer.status) {
    case "unsupported":
      return LABEL_PRINTER_MESSAGES.unsupported
    case "connecting":
      return printer.name ? `Connecting to ${printer.name}` : "Connecting"
    case "connected":
      return `${printer.name}, connected`
    case "printing":
      return `${printer.name}, printing`
    case "idle":
      return "Not connected. Print asks you to pick the D110 first."
  }
}

const NOTE = "text-[13px] leading-[1.45] text-muted-foreground-2"

interface Outcome {
  tone: "info" | "error"
  text: string
}

function Body({ items, onDone }: { items: readonly PriceLabelItem[]; onDone: () => void }) {
  const printer = useLabelPrinter()
  const [copies, setCopies] = React.useState<Record<string, number | "">>(() =>
    Object.fromEntries(items.map((item) => [item.id, item.copies]))
  )
  const [sizeKey, setSizeKey] = React.useState<PriceLabelSizeKey>(
    () => priceLabelSize(readSetting(SIZE_KEY) ?? DEFAULT_PRICE_LABEL_SIZE).key
  )
  const [darkness, setDarkness] = React.useState<Darkness>(() => {
    const saved = readSetting(DARKNESS_KEY)
    return isDarkness(saved) ? saved : "normal"
  })
  const [preview, setPreview] = React.useState<string | null>(null)
  const [progress, setProgress] = React.useState<{ printed: number; total: number } | null>(null)
  const [outcome, setOutcome] = React.useState<Outcome | null>(null)
  const [busy, setBusy] = React.useState(false)

  const size = priceLabelSize(sizeKey)
  const rows = printableRows(items, copies)
  const total = totalLabels(rows)
  const first = items.find(hasPrice)
  // By value: a caller that builds its list inline hands over new objects on
  // every render, and the preview should only redraw when the label changes.
  const firstTitle = first?.title
  const firstPrice = first?.price

  // The library is fetched as the sheet opens, so the press that shows
  // Chrome's list never waits on the network.
  React.useEffect(() => {
    if (bluetoothSupported()) void loadPrinterLibrary().catch(() => undefined)
  }, [])

  // The first priced item as it will print, redrawn when the roll changes.
  React.useEffect(() => {
    if (firstTitle === undefined || firstPrice === undefined) return
    let live = true
    void import("./render")
      .then(({ drawPriceLabels }) => drawPriceLabels([{ title: firstTitle, price: firstPrice }], size))
      .then(([canvas]) => {
        if (live && canvas) setPreview(canvas.toDataURL("image/png"))
      })
      .catch(() => {
        if (live) setPreview(null)
      })
    return () => {
      live = false
    }
  }, [firstTitle, firstPrice, size])

  async function print() {
    if (total === 0 || busy) return
    setOutcome(null)
    setBusy(true)
    let stage: "connect" | "print" = "connect"
    try {
      // Straight from the press: Chrome only shows its list inside a click.
      if (printer.status !== "connected") await connectLabelPrinter()
      stage = "print"
      const { drawPriceLabels } = await import("./render")
      const canvases = await drawPriceLabels(
        rows.map((row) => ({ title: row.item.title, price: row.item.price })),
        size
      )
      setProgress({ printed: 0, total })
      const printed = await printLabels(
        rows.map((row, index) => ({ canvas: canvases[index] as HTMLCanvasElement, copies: row.copies })),
        darkness,
        (done, of) => setProgress({ printed: done, total: of })
      )
      setOutcome({
        tone: "info",
        text: printed === 1 ? "1 label printed." : `${printed} labels printed.`,
      })
    } catch (error) {
      const fault = describeLabelPrinterError(error, stage)
      if (fault.printed > 0) {
        // What is left goes back into the counts, so Print again finishes the job.
        setCopies((now) => ({ ...now, ...remainingAfter(rows, fault.printed) }))
        setOutcome({
          tone: "error",
          text: `${fault.message} ${fault.printed} of ${total} came out first; the counts below are what is left.`,
        })
      } else {
        setOutcome({ tone: "error", text: fault.message })
      }
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const unsupported = printer.status === "unsupported"

  return (
    <>
      <SheetBody>
        <div className="flex flex-col gap-10">
          <section aria-label="The label">
            <MicroLabel className="mb-4 block">What prints</MicroLabel>
            {first ? (
              <div
                data-testid="price-label-preview"
                className="inline-flex border border-hairline bg-white"
                style={{ width: size.width + 2, height: size.height + 2 }}
              >
                {preview ? (
                  <img
                    src={preview}
                    alt={`${first.title}, ${formatGBP(first.price)}, with the GG logo`}
                    width={size.width}
                    height={size.height}
                    className="[image-rendering:pixelated]"
                  />
                ) : null}
              </div>
            ) : (
              <p data-testid="price-label-none" className="max-w-[44ch] text-[15px] leading-[1.5] text-muted-foreground">
                {items.length === 1
                  ? "This item has no price yet. Set one on the item page, then print."
                  : "None of these has a price yet. Set prices on the item pages, then print."}
              </p>
            )}
          </section>

          <section aria-label="What to print">
            <MicroLabel className="mb-2 block">How many</MicroLabel>
            <ul data-testid="price-label-rows">
              {items.map((item) => (
                <li
                  key={item.id}
                  data-testid="price-label-row"
                  className="flex min-h-14 items-center justify-between gap-6 border-b border-hairline-soft py-3 first:border-t"
                >
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="truncate text-[15px] text-foreground">{item.title}</span>
                    <span className={NOTE}>
                      <span className="tnum font-mono">{displayCode(item.sku)}</span>
                      {hasPrice(item) ? `, ${formatGBP(item.price)}` : ""}
                    </span>
                  </span>
                  {hasPrice(item) ? (
                    <Stepper
                      id={`price-label-copies-${item.id}`}
                      label={`Labels for ${item.title}`}
                      value={copies[item.id] ?? item.copies}
                      disabled={busy}
                      onChange={(next) =>
                        setCopies((now) => ({
                          ...now,
                          [item.id]: next === "" ? "" : Math.min(MAX_COPIES, next),
                        }))
                      }
                    />
                  ) : (
                    <Hint className="shrink-0">No price</Hint>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <div className="grid gap-8 sm:grid-cols-2">
            <Field label="Label" htmlFor="price-label-size" layout="stacked">
              <Select
                value={sizeKey}
                onValueChange={(next: string | null) => {
                  const key = priceLabelSize(next).key
                  setSizeKey(key)
                  writeSetting(SIZE_KEY, key)
                }}
              >
                <SelectTrigger id="price-label-size">
                  <SelectValue>{(value: string) => priceLabelSize(value).name}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {PRICE_LABEL_SIZES.map((option) => (
                    <SelectItem key={option.key} value={option.key}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Darkness" htmlFor="price-label-darkness" layout="stacked">
              <Select
                value={darkness}
                onValueChange={(next: string | null) => {
                  if (!isDarkness(next)) return
                  setDarkness(next)
                  writeSetting(DARKNESS_KEY, next)
                }}
              >
                <SelectTrigger id="price-label-darkness">
                  <SelectValue>
                    {(value: string) => DARKNESS.find((option) => option.value === value)?.label ?? "Normal"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {DARKNESS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <section aria-label="Printer" data-testid="price-label-printer">
            <MicroLabel className="mb-2 block">Printer</MicroLabel>
            <p
              data-testid="price-label-printer-status"
              className={
                unsupported
                  ? "max-w-[56ch] text-[15px] leading-[1.5] text-destructive"
                  : "text-[15px] leading-[1.5] text-foreground"
              }
            >
              {printerLine(printer)}
            </p>
            {printer.status === "connected" || printer.status === "idle" ? (
              <Button
                variant="text"
                className="mt-3"
                disabled={busy}
                onClick={() => {
                  setOutcome(null)
                  void connectLabelPrinter().catch((error: unknown) =>
                    setOutcome({ tone: "error", text: describeLabelPrinterError(error, "connect").message })
                  )
                }}
              >
                {printer.status === "connected" ? "Change printer" : "Connect printer"}
              </Button>
            ) : null}
          </section>
        </div>

        {progress ? (
          <p data-testid="price-label-progress" aria-live="polite" className="mt-8 text-[15px] text-foreground">
            {progress.printed === 0
              ? "Sending to the printer"
              : `Printed ${progress.printed} of ${progress.total}`}
          </p>
        ) : null}
        {outcome?.tone === "error" ? (
          <FieldError data-testid="price-label-error">{outcome.text}</FieldError>
        ) : outcome ? (
          <p data-testid="price-label-outcome" aria-live="polite" className="mt-8 text-[15px] text-foreground">
            {outcome.text}
          </p>
        ) : null}
      </SheetBody>

      <SheetFooter>
        <Button
          trailingArrow
          data-testid="price-label-print"
          loading={busy}
          disabled={unsupported || total === 0 || printer.status === "connecting"}
          onClick={() => void print()}
        >
          {total === 0 ? "Print" : printLabelText(total)}
        </Button>
        <Button variant="text" onClick={onDone}>
          {outcome?.tone === "info" ? "Close" : "Cancel"}
        </Button>
      </SheetFooter>
    </>
  )
}

export interface PriceLabelSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: readonly PriceLabelItem[]
}

export function PriceLabelSheet({ open, onOpenChange, items }: PriceLabelSheetProps) {
  const many = items.length > 1
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" data-testid="price-label-sheet" className="pb-[env(safe-area-inset-bottom)]">
        <SheetHeader>
          <SheetTitle>{many ? "Print prices" : "Print price"}</SheetTitle>
          <SheetDescription>
            The logo, the name and the price, on the Niimbot label printer by Bluetooth.
          </SheetDescription>
        </SheetHeader>
        {/* Mounted with the sheet, so the counts start from the caller's every time. */}
        <Body items={items} onDone={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  )
}
