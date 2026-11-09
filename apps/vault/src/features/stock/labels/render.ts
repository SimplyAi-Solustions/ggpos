/**
 * Price labels drawn for the printer: the app's fonts loaded first, the
 * layout measured with them, painted one bit deep. Imported when a print is
 * asked for, never with the app. Ported from apps/web/src/features/price-labels.
 */
import { canvasMeasure, canvasToBlob, loadFonts, paintLayout } from "./paint"
import { labelText, priceLabelLayout, type PriceLabelContent, type PriceLabelSize } from "./layout"

export async function drawPriceLabels(
  contents: readonly PriceLabelContent[],
  size: PriceLabelSize
): Promise<HTMLCanvasElement[]> {
  await loadFonts(labelText(contents))
  const measure = canvasMeasure()
  return contents.map((content) => paintLayout(priceLabelLayout(content, size, measure)))
}

/** One PNG per label, for the share sheet on a phone. */
export async function drawPriceLabelFiles(
  contents: readonly (PriceLabelContent & { sku: string })[],
  size: PriceLabelSize
): Promise<File[]> {
  const canvases = await drawPriceLabels(contents, size)
  return Promise.all(
    canvases.map(async (canvas, index) => {
      const blob = await canvasToBlob(canvas)
      const sku = contents[index]?.sku ?? `label-${index + 1}`
      return new File([blob], `${sku}-label.png`, { type: "image/png" })
    })
  )
}
