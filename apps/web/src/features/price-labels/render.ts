/**
 * Price labels drawn for the printer: the app's fonts loaded first, the
 * layout measured with them, painted one bit deep by the receipt painter.
 *
 * The painter carries bwip-js, so this module is imported when a price label
 * sheet asks for it, never with the app.
 */
import { canvasMeasure, loadFonts, paintLayout } from "@/features/printing/receipt/paint"

import {
  labelText,
  priceLabelLayout,
  type PriceLabelContent,
  type PriceLabelSize,
} from "./layout"

export async function drawPriceLabels(
  contents: readonly PriceLabelContent[],
  size: PriceLabelSize
): Promise<HTMLCanvasElement[]> {
  await loadFonts(labelText(contents))
  const measure = canvasMeasure()
  return contents.map((content) => paintLayout(priceLabelLayout(content, size, measure)))
}
