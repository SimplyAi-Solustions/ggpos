/**
 * Printing a receipt, a report or the drawer from the counter
 * (docs/api-contract-epos.md, section 6, "The renderer").
 *
 * Each call finds the register's printer, draws the page at that printer's
 * width, posts the PNG as a print job, and reports what happened as a
 * `PrintOutcome`. None of them throws: the till shows `message` as one line
 * and carries on, because a sale that is paid for must never be held up by a
 * printer that is out of paper.
 *
 * With no printer for the register a receipt falls back to the browser print
 * page at 80 mm (`/print/receipt/$id`), which is what a counter with only a
 * USB or Wi-Fi printer on the Mac uses.
 */
import type { NamedRef, Printer } from "@gg/shared"

import { currentRegisterId } from "@/lib/api/till-session"
import {
  getReceipt,
  getTillReport,
  listPrinters,
  listRegisters,
  PRINTERS_KEY,
  printingMessage,
  sendDrawerKick,
  sendPrintJob,
} from "@/lib/api/printing"
import { queryClient } from "@/lib/query"

import { dotsFor } from "./draw"

export type PrintOutcome = { ok: true; jobId: string } | { ok: false; message: string }

/** The dots across a printer prints at its paper width. */
function widthOf(printer: Pick<Printer, "paper_width">) {
  return dotsFor(printer.paper_width)
}

/**
 * The register this call is for and the printer that serves it. The
 * register is the one passed, else this browser's own, else the shop's
 * default (the first active one), the same order the server uses.
 */
async function target(
  registerId: string | undefined
): Promise<{ register: NamedRef | null; printer: Printer | null }> {
  const [registers, printers] = await Promise.all([
    queryClient.fetchQuery({
      queryKey: ["registers"],
      queryFn: listRegisters,
      staleTime: 60_000,
    }),
    queryClient.fetchQuery({ queryKey: PRINTERS_KEY, queryFn: listPrinters, staleTime: 10_000 }),
  ])
  const wanted = registerId ?? currentRegisterId()
  const register = wanted
    ? (registers.find((row) => row.id === wanted) ?? null)
    : (registers[0] ?? null)
  if (!register) return { register: null, printer: null }
  const serving = printers.filter((row) => row.active && row.register === register.id)
  // One that is answering beats one that is not.
  const printer = serving.find((row) => row.online) ?? serving[0] ?? null
  return { register, printer }
}

function noPrinter(register: NamedRef | null): string {
  return `No receipt printer is set up for ${register?.name ?? "this register"}.`
}

/** The URL of the browser print page for a receipt. */
export function browserReceiptUrl(input: {
  saleId: string
  gift?: boolean
  refundRef?: string
  reprint?: boolean
}): string {
  const query = new URLSearchParams()
  if (input.gift) query.set("gift", "1")
  if (input.refundRef) query.set("refund", input.refundRef)
  if (input.reprint) query.set("reprint", "1")
  const text = query.toString()
  return `/print/receipt/${encodeURIComponent(input.saleId)}${text ? `?${text}` : ""}`
}

/**
 * Print a sale's receipt, its gift receipt (`gift`) or a refund's receipt
 * (`refundRef`). `drawer` opens the drawer with it, which a cash sale wants;
 * `reprint` tells the server it is a second copy so it can be logged.
 */
export async function printReceipt(input: {
  saleId: string
  register?: string
  gift?: boolean
  refundRef?: string
  drawer?: boolean
  reprint?: boolean
}): Promise<PrintOutcome> {
  try {
    const { register, printer } = await target(input.register)
    if (!printer) {
      const opened = window.open(browserReceiptUrl(input), "_blank")
      return {
        ok: false,
        message: `${noPrinter(register)} Printing in the browser instead.${
          opened ? "" : " Allow pop-ups for this site if nothing opened."
        }`,
      }
    }
    const receipt = await getReceipt(input)
    // Loaded now, not at start-up: the painter carries bwip-js.
    const { renderReceiptImage } = await import("./render")
    const image = await renderReceiptImage(receipt, { width: widthOf(printer), gift: input.gift })
    const job = await sendPrintJob({
      printer: printer.id,
      kind: input.gift ? "gift_receipt" : input.refundRef ? "refund_receipt" : "receipt",
      ref: input.saleId,
      image,
      drawer: input.drawer ?? false,
    })
    return { ok: true, jobId: job.id }
  } catch (error) {
    return {
      ok: false,
      message: printingMessage(
        error,
        "The receipt did not reach the printer. Check it is switched on, then print it again from the sale."
      ),
    }
  }
}

/** Print a saved X or Z report. There is no browser fallback for a report. */
export async function printTillReport(input: {
  reportId: string
  register?: string
}): Promise<PrintOutcome> {
  try {
    const { register, printer } = await target(input.register)
    if (!printer) {
      return { ok: false, message: `${noPrinter(register)} Add one under Settings, Printers.` }
    }
    const report = await getTillReport(input.reportId)
    const { renderTillReportImage } = await import("./render")
    const image = await renderTillReportImage(report, { width: widthOf(printer) })
    const job = await sendPrintJob({
      printer: printer.id,
      kind: report.type === "z" ? "z_report" : "x_report",
      ref: input.reportId,
      image,
    })
    return { ok: true, jobId: job.id }
  } catch (error) {
    return {
      ok: false,
      message: printingMessage(
        error,
        "The report did not reach the printer. Check it is switched on, then print it again from Reports."
      ),
    }
  }
}

/** Open the cash drawer with no paper. */
export async function openDrawer(register?: string): Promise<PrintOutcome> {
  try {
    const job = await sendDrawerKick(register ?? currentRegisterId())
    return { ok: true, jobId: job.id }
  } catch (error) {
    return {
      ok: false,
      message: printingMessage(
        error,
        "The drawer did not open. Use the drawer key, and check the printer is on."
      ),
    }
  }
}
