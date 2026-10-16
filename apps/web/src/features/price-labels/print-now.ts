/**
 * One press, labels out: the stock list's print button on each row.
 *
 * It connects first when it has to (Chrome's printer list, from the same
 * press), draws with this browser's roll and darkness, and prints, with no
 * sheet in between. Anything that goes wrong comes back as a
 * `LabelPrinterError` carrying the sentence to show.
 */
import { priceLabelSize } from "./layout"
import {
  connectLabelPrinter,
  describeLabelPrinterError,
  labelPrinterState,
  printLabels,
} from "./niimbot"
import { hasPrice } from "./plan"
import { savedDarkness, savedLabelSize } from "./settings"

export interface QuickLabel {
  title: string
  /** Pence. */
  price: number
  copies: number
}

/** Answers how many labels came out. */
export async function printPricesNow(labels: readonly QuickLabel[]): Promise<number> {
  const rows = labels.filter((label) => hasPrice(label) && label.copies > 0)
  if (rows.length === 0) return 0
  let stage: "connect" | "print" = "connect"
  try {
    if (labelPrinterState().status !== "connected") await connectLabelPrinter()
    stage = "print"
    const { drawPriceLabels } = await import("./render")
    const canvases = await drawPriceLabels(
      rows.map((row) => ({ title: row.title, price: row.price })),
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
