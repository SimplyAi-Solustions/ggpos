/**
 * Receipts, reports and the cash drawer through the counter's receipt
 * printer (docs/api-contract-epos.md, section 6, "The renderer").
 *
 * STUB. The printing package replaces this file with the canvas renderer
 * and the print-job calls; the signatures below are the contract the till
 * and cashing up already call, so they do not change when it lands. Until
 * then every call reports that printing is not set up, which the till shows
 * as one line and carries on.
 */
/* eslint-disable @typescript-eslint/no-unused-vars -- a stub keeps the contract's signatures */
import type { ReceiptData, TillReport } from "@gg/shared"

export type PrintOutcome = { ok: true; jobId: string } | { ok: false; message: string }

const NOT_READY_MESSAGE =
  "Receipt printing is not set up yet. Add a printer under Settings, Printers."
const NOT_READY: PrintOutcome = { ok: false, message: NOT_READY_MESSAGE }

export async function renderReceiptImage(
  _receipt: ReceiptData,
  _opts: { width: 576 | 384; gift?: boolean }
): Promise<Blob> {
  throw new Error(NOT_READY_MESSAGE)
}

export async function renderTillReportImage(
  _report: TillReport,
  _opts: { width: 576 | 384 }
): Promise<Blob> {
  throw new Error(NOT_READY_MESSAGE)
}

export async function printReceipt(_input: {
  saleId: string
  register?: string
  gift?: boolean
  refundRef?: string
  drawer?: boolean
  reprint?: boolean
}): Promise<PrintOutcome> {
  return NOT_READY
}

export async function printTillReport(_input: {
  reportId: string
  register?: string
}): Promise<PrintOutcome> {
  return NOT_READY
}

export async function openDrawer(_register?: string): Promise<PrintOutcome> {
  return NOT_READY
}
