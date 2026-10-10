/**
 * Receipts, reports and the cash drawer through the counter's receipt
 * printer (docs/api-contract-epos.md, section 6, "The renderer").
 *
 * The till and cashing up import from here and nowhere deeper:
 *
 *   renderReceiptImage(receipt, { width, gift })  a sale, gift or refund receipt as a PNG
 *   renderTillReportImage(report, { width })      an X or Z report as a PNG
 *   printReceipt / printTillReport / openDrawer   draw, post the job, report what happened
 *
 * Receipts are drawn on a canvas in the app's own fonts, black on white and
 * thresholded to one bit, exactly as wide as the printer's paper (576 dots on
 * 80 mm, 384 on 58 mm), and the printer collects them from the server (Star
 * CloudPRNT). The layout is pure data (`receipt-layout.ts`,
 * `report-layout.ts`) and the canvas painter is thin (`paint.ts`).
 *
 * The two render functions load the painter on first use. It carries
 * bwip-js for the barcode and the QR, which is 900 kB nobody opening the till
 * should pay for until they print something.
 */
import type { ReceiptData, TillReport } from "@gg/shared"

export { printReceipt, printTillReport, openDrawer, browserReceiptUrl } from "./print"
export type { PrintOutcome } from "./print"
export { varianceWords } from "./report-layout"

export async function renderReceiptImage(
  receipt: ReceiptData,
  opts: { width: 576 | 384; gift?: boolean }
): Promise<Blob> {
  const { renderReceiptImage: render } = await import("./render")
  return render(receipt, opts)
}

export async function renderTillReportImage(
  report: TillReport,
  opts: { width: 576 | 384 }
): Promise<Blob> {
  const { renderTillReportImage: render } = await import("./render")
  return render(report, opts)
}
