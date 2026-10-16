/**
 * Receipt printers, print jobs and the cash drawer
 * (docs/api-contract-epos.md, section 6).
 *
 * The counter never talks to a printer. It draws the receipt, posts the PNG
 * here, and the printer collects it from the server on its own (Star
 * CloudPRNT), so the Mac and the tablet print to the same machine and open
 * the same drawer.
 *
 * Not re-exported from `lib/api/index.ts` on purpose: that barrel travels in
 * the entry chunk, and printing belongs to the till, cashing up and Settings.
 */
import type {
  NamedRef,
  Printer,
  PrintJob,
  PrintJobKind,
  ReceiptData,
  TillReport,
} from "@gg/shared"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { noteNetworkSuccess } from "@/lib/offline/net"
import { refusalOrFallback } from "@/lib/api/refusal"
import * as demo from "@/lib/api/demo/printing"

export const PRINTERS_KEY = ["printers"] as const

/**
 * The sentence for a failed printing call: the server's own when it wrote
 * one, else `fallback`. A reply with no body at all (a 404 from a proxy, an
 * old server) reaches the SDK's own default, which tells staff nothing, so
 * that is replaced too.
 */
export function printingMessage(error: unknown, fallback: string): string {
  const message = refusalOrFallback(error, fallback)
  return message === "Something went wrong." ? fallback : message
}

/** The printers, with `online` true for one that polled in the last 30 seconds. */
export async function listPrinters(): Promise<Printer[]> {
  if (isDemo()) return demo.listPrinters()
  const result = await pb.send<{ printers?: Printer[] }>("/api/vault/printers", {
    method: "GET",
  })
  noteNetworkSuccess()
  return result.printers ?? []
}

export interface NewPrinter {
  name: string
  mac: string
  register: string
  paper_width: 80 | 58
  model?: string
}

/** What adding or rotating returns: the printer and the URL to type into it, shown once. */
export interface PrinterWithUrl {
  printer: Printer
  url: string
}

/** Admin: add a printer. The URL comes back this once and is never stored readable. */
export async function createPrinter(input: NewPrinter): Promise<PrinterWithUrl> {
  if (isDemo()) return demo.createPrinter(input)
  const result = await pb.send<PrinterWithUrl>("/api/vault/printers", {
    method: "POST",
    body: input,
  })
  noteNetworkSuccess()
  return result
}

/** Admin: a new URL. The old one stops working at once. */
export async function rotatePrinter(id: string): Promise<PrinterWithUrl> {
  if (isDemo()) return demo.rotatePrinter(id)
  const result = await pb.send<PrinterWithUrl>(
    `/api/vault/printers/${encodeURIComponent(id)}/rotate`,
    { method: "POST" }
  )
  noteNetworkSuccess()
  return result
}

/** Admin: remove a printer and its queue. */
export async function removePrinter(id: string): Promise<void> {
  if (isDemo()) {
    demo.removePrinter(id)
    return
  }
  await pb.send(`/api/vault/printers/${encodeURIComponent(id)}`, { method: "DELETE" })
  noteNetworkSuccess()
}

/** The active registers, the default (lowest sort) first. */
export async function listRegisters(): Promise<NamedRef[]> {
  if (isDemo()) return demo.listRegisters()
  const rows = await pb.collection("registers").getFullList({
    filter: "active = true",
    sort: "sort,created",
  })
  noteNetworkSuccess()
  return rows.map((row) => ({ id: row.id, name: String(row.name ?? "") }))
}

/**
 * The data for one receipt. `refundRef` asks for a refund's receipt, `gift`
 * is the same data (the renderer hides the prices) and `reprint` makes the
 * server log the reprint.
 */
export async function getReceipt(input: {
  saleId: string
  gift?: boolean
  refundRef?: string
  reprint?: boolean
}): Promise<ReceiptData> {
  if (isDemo()) return demo.getReceipt(input)
  const query: Record<string, string> = {}
  if (input.gift) query.gift = "1"
  if (input.refundRef) query.refund = input.refundRef
  if (input.reprint) query.reprint = "1"
  const result = await pb.send<{ receipt: ReceiptData }>(
    `/api/vault/sales/${encodeURIComponent(input.saleId)}/receipt`,
    { method: "GET", query }
  )
  noteNetworkSuccess()
  return result.receipt
}

/** A saved X or Z report, for printing. */
export async function getTillReport(reportId: string): Promise<TillReport> {
  if (isDemo()) return demo.getTillReport(reportId)
  const result = await pb.send<{ report: TillReport }>(
    `/api/vault/till/reports/${encodeURIComponent(reportId)}`,
    { method: "GET" }
  )
  noteNetworkSuccess()
  return result.report
}

export interface PrintJobInput {
  /** The printer, or leave it out and name the register to use that one's printer. */
  printer?: string
  register?: string
  kind: PrintJobKind
  /** The sale, report or event the job is for. */
  ref?: string
  /** A PNG exactly as wide as the printer's paper. */
  image?: Blob
  /** Plain text, when there is no image. */
  text?: string
  drawer?: boolean
  cut?: boolean
  copies?: number
}

/** Queue a print job. The server refuses an image of the wrong width. */
export async function sendPrintJob(input: PrintJobInput): Promise<PrintJob> {
  if (isDemo()) return demo.sendPrintJob(input)
  const body = new FormData()
  body.append("kind", input.kind)
  if (input.printer) body.append("printer", input.printer)
  if (input.register) body.append("register", input.register)
  if (input.ref) body.append("ref", input.ref)
  if (input.image) body.append("file", input.image, "receipt.png")
  if (input.text) body.append("text", input.text)
  if (input.drawer !== undefined) body.append("drawer", String(input.drawer))
  if (input.cut !== undefined) body.append("cut", String(input.cut))
  if (input.copies !== undefined) body.append("copies", String(input.copies))
  const result = await pb.send<{ job: PrintJob }>("/api/vault/print/jobs", {
    method: "POST",
    body,
  })
  noteNetworkSuccess()
  return result.job
}

/** Open the drawer with no paper. 409 when the register has no printer. */
export async function sendDrawerKick(register?: string): Promise<PrintJob> {
  if (isDemo()) return demo.sendDrawerKick(register)
  const result = await pb.send<{ job: PrintJob }>("/api/vault/print/drawer", {
    method: "POST",
    body: register ? { register } : {},
  })
  noteNetworkSuccess()
  return result.job
}

export interface PrintJobList {
  items: PrintJob[]
  page: number
  per_page: number
  total: number
}

export async function listPrintJobs(
  filter: { register?: string; status?: string; page?: number } = {}
): Promise<PrintJobList> {
  if (isDemo()) return demo.listPrintJobs(filter)
  const query: Record<string, string> = {}
  if (filter.register) query.register = filter.register
  if (filter.status) query.status = filter.status
  if (filter.page) query.page = String(filter.page)
  const result = await pb.send<PrintJobList>("/api/vault/print/jobs", {
    method: "GET",
    query,
  })
  noteNetworkSuccess()
  return result
}

/** Put a failed job back in the queue. */
export async function retryPrintJob(id: string): Promise<PrintJob> {
  if (isDemo()) return demo.retryPrintJob(id)
  const result = await pb.send<{ job: PrintJob }>(
    `/api/vault/print/jobs/${encodeURIComponent(id)}/retry`,
    { method: "POST" }
  )
  noteNetworkSuccess()
  return result.job
}
