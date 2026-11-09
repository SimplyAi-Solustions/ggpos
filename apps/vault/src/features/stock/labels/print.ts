/**
 * Two ways a price label comes out:
 *
 * - Over Web Bluetooth to the Niimbot D110 (Chrome or Edge on the Mac mini,
 *   or Android Chrome), exactly as apps/web prints it.
 * - On an iPhone, where Safari has no Web Bluetooth: the label is drawn as a
 *   PNG and handed to the share sheet, so it can go to the NIIMBOT app.
 */
import { priceLabelSize } from "./layout"
import {
  bluetoothSupported,
  connectLabelPrinter,
  describeLabelPrinterError,
  labelPrinterState,
  printLabels,
} from "./niimbot"
import { hasPrice } from "./plan"
import { savedDarkness, savedLabelSize } from "./settings"

export interface QuickLabel {
  sku: string
  title: string
  /** Pence. */
  price: number
  copies: number
}

export type PrintRoute = "bluetooth" | "share" | "download"

/** Which way this device can print. */
export function printRoute(): PrintRoute {
  if (bluetoothSupported()) return "bluetooth"
  if (typeof navigator !== "undefined" && typeof navigator.canShare === "function") return "share"
  return "download"
}

/** Prints over Bluetooth. Answers how many labels came out. */
export async function printOverBluetooth(labels: readonly QuickLabel[]): Promise<number> {
  const rows = labels.filter((label) => hasPrice(label) && label.copies > 0)
  if (rows.length === 0) return 0
  let stage: "connect" | "print" = "connect"
  try {
    if (labelPrinterState().status !== "connected") await connectLabelPrinter()
    stage = "print"
    const { drawPriceLabels } = await import("./render")
    const canvases = await drawPriceLabels(
      rows.map((row) => ({ title: row.title, price: row.price, sku: row.sku })),
      priceLabelSize(savedLabelSize())
    )
    return await printLabels(
      rows.map((row, index) => ({ canvas: canvases[index] as HTMLCanvasElement, copies: row.copies })),
      savedDarkness()
    )
  } catch (error) {
    throw describeLabelPrinterError(error, stage)
  }
}

/**
 * Draws one PNG per item and opens the share sheet (or downloads them where
 * there is none). Answers how many images were handed over.
 */
export async function shareLabelImages(labels: readonly QuickLabel[]): Promise<number> {
  const rows = labels.filter((label) => hasPrice(label))
  if (rows.length === 0) return 0
  const { drawPriceLabelFiles } = await import("./render")
  const files = await drawPriceLabelFiles(
    rows.map((row) => ({ sku: row.sku, title: row.title, price: row.price })),
    priceLabelSize(savedLabelSize())
  )
  if (typeof navigator !== "undefined" && navigator.canShare?.({ files })) {
    await navigator.share({ files, title: files.length === 1 ? "Price label" : "Price labels" })
    return files.length
  }
  for (const file of files) {
    const url = URL.createObjectURL(file)
    const link = document.createElement("a")
    link.href = url
    link.download = file.name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return files.length
}

/** Bluetooth where the browser has it, the share sheet everywhere else. */
export async function printPriceLabels(labels: readonly QuickLabel[]): Promise<{ count: number; route: PrintRoute }> {
  const route = printRoute()
  if (route === "bluetooth") return { count: await printOverBluetooth(labels), route }
  return { count: await shareLabelImages(labels), route }
}
