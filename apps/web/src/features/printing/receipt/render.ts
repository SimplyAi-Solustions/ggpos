/**
 * The three images the counter sends a printer, drawn in the browser
 * (docs/api-contract-epos.md, section 6, "The renderer").
 *
 * `renderReceiptImage` and `renderTillReportImage` are the contract's two
 * functions; `renderTestImage` is the short test print on Settings, Printers.
 * Each is the pure layout from its own module, painted by `paint.ts`.
 */
import type { ReceiptData, TillReport } from "@gg/shared"

import type { PaperWidth } from "./draw"
import { drawToBlob } from "./paint"
import { layoutReceipt, layoutTestReceipt } from "./receipt-layout"
import { layoutTillReport } from "./report-layout"

/** A receipt, a gift receipt (no prices) or a refund receipt, as a PNG `width` dots across. */
export function renderReceiptImage(
  receipt: ReceiptData,
  opts: { width: PaperWidth; gift?: boolean }
): Promise<Blob> {
  return drawToBlob(JSON.stringify(receipt), (measure) =>
    layoutReceipt(receipt, { width: opts.width, gift: opts.gift, measure })
  )
}

/** An X or Z report as a PNG `width` dots across. */
export function renderTillReportImage(
  report: TillReport,
  opts: { width: PaperWidth }
): Promise<Blob> {
  return drawToBlob(JSON.stringify(report), (measure) =>
    layoutTillReport(report, { width: opts.width, measure })
  )
}

/** The short test print: every face, a barcode and a QR. */
export function renderTestImage(opts: {
  width: PaperWidth
  printerName: string
  qrValue?: string
}): Promise<Blob> {
  const qrValue =
    opts.qrValue ?? (typeof window === "undefined" ? "" : window.location.origin)
  return drawToBlob(opts.printerName, (measure) =>
    layoutTestReceipt({
      width: opts.width,
      measure,
      printerName: opts.printerName,
      now: new Date(),
      qrValue,
    })
  )
}
