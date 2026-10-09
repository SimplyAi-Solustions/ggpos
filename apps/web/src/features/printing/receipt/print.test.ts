import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { NamedRef, Printer } from "@gg/shared"

import { getReceipt as sampleReceipt, getTillReport as sampleReport } from "@/lib/api/demo/printing"

/**
 * What the counter does when it prints: find the register's printer, draw at
 * its width, post the job, and report in one line. The API and the painter
 * are stood in for; what is under test is the decision-making around them.
 */

const api = vi.hoisted(() => ({
  listPrinters: vi.fn(),
  listRegisters: vi.fn(),
  getReceipt: vi.fn(),
  getTillReport: vi.fn(),
  sendPrintJob: vi.fn(),
  sendDrawerKick: vi.fn(),
}))
const painter = vi.hoisted(() => ({
  renderReceiptImage: vi.fn(),
  renderTillReportImage: vi.fn(),
}))
const device = vi.hoisted(() => ({ register: undefined as string | undefined }))

// The calls are stood in for; the keys and the message helper are the real ones.
vi.mock("@/lib/api/printing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/printing")>()),
  ...api,
}))
vi.mock("./render", () => painter)
vi.mock("@/lib/api/till-session", () => ({ currentRegisterId: () => device.register }))

const { queryClient } = await import("@/lib/query")
const { browserReceiptUrl, openDrawer, printReceipt, printTillReport } = await import("./print")

const COUNTER: NamedRef = { id: "r_counter", name: "Counter" }
const BACK: NamedRef = { id: "r_back", name: "Back office" }

function printer(over: Partial<Printer> = {}): Printer {
  return {
    id: "p_counter",
    name: "Counter printer",
    model: "Star TSP143IV",
    mac: "00:11:e5:06:04:ff",
    register: COUNTER.id,
    register_name: COUNTER.name,
    paper_width: 80,
    active: true,
    last_poll_at: "2026-10-09T12:00:00.000Z",
    last_status: "200 OK",
    online: true,
    ...over,
  }
}

const IMAGE = new Blob(["png"], { type: "image/png" })

let open: ReturnType<typeof vi.fn>

beforeEach(() => {
  queryClient.clear()
  device.register = undefined
  for (const fn of [...Object.values(api), ...Object.values(painter)]) fn.mockReset()
  api.listRegisters.mockResolvedValue([COUNTER, BACK])
  api.listPrinters.mockResolvedValue([printer()])
  api.getReceipt.mockResolvedValue(sampleReceipt({ saleId: "sale_1" }))
  api.getTillReport.mockResolvedValue(sampleReport("z_1"))
  api.sendPrintJob.mockResolvedValue({ id: "job_1" })
  api.sendDrawerKick.mockResolvedValue({ id: "job_drawer" })
  painter.renderReceiptImage.mockResolvedValue(IMAGE)
  painter.renderTillReportImage.mockResolvedValue(IMAGE)
  open = vi.fn(() => ({}))
  vi.stubGlobal("open", open)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("printReceipt with a printer", () => {
  it("draws the receipt at the printer's width and posts it as a receipt job", async () => {
    const outcome = await printReceipt({ saleId: "sale_1", drawer: true })
    expect(outcome).toEqual({ ok: true, jobId: "job_1" })
    expect(api.getReceipt).toHaveBeenCalledWith(expect.objectContaining({ saleId: "sale_1" }))
    expect(painter.renderReceiptImage).toHaveBeenCalledWith(expect.anything(), {
      width: 576,
      gift: undefined,
    })
    expect(api.sendPrintJob).toHaveBeenCalledWith({
      printer: "p_counter",
      kind: "receipt",
      ref: "sale_1",
      image: IMAGE,
      drawer: true,
    })
    expect(open).not.toHaveBeenCalled()
  })

  it("does not open the drawer unless asked", async () => {
    await printReceipt({ saleId: "sale_1" })
    expect(api.sendPrintJob).toHaveBeenCalledWith(expect.objectContaining({ drawer: false }))
  })

  it("draws at 384 dots for a 58 mm printer", async () => {
    api.listPrinters.mockResolvedValue([printer({ paper_width: 58 })])
    await printReceipt({ saleId: "sale_1" })
    expect(painter.renderReceiptImage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ width: 384 }))
  })

  it("asks for the gift receipt and sends it as one", async () => {
    await printReceipt({ saleId: "sale_1", gift: true })
    expect(api.getReceipt).toHaveBeenCalledWith(expect.objectContaining({ gift: true }))
    expect(painter.renderReceiptImage).toHaveBeenCalledWith(expect.anything(), { width: 576, gift: true })
    expect(api.sendPrintJob).toHaveBeenCalledWith(expect.objectContaining({ kind: "gift_receipt" }))
  })

  it("asks for a refund's receipt by its reference and sends it as a refund receipt", async () => {
    await printReceipt({ saleId: "sale_1", refundRef: "GG-S-000456-R1" })
    expect(api.getReceipt).toHaveBeenCalledWith(expect.objectContaining({ refundRef: "GG-S-000456-R1" }))
    expect(api.sendPrintJob).toHaveBeenCalledWith(expect.objectContaining({ kind: "refund_receipt" }))
  })

  it("tells the server a reprint is a reprint", async () => {
    await printReceipt({ saleId: "sale_1", reprint: true })
    expect(api.getReceipt).toHaveBeenCalledWith(expect.objectContaining({ reprint: true }))
  })

  it("uses the register that was passed, not this browser's", async () => {
    device.register = COUNTER.id
    api.listPrinters.mockResolvedValue([
      printer(),
      printer({ id: "p_back", register: BACK.id, register_name: BACK.name, paper_width: 58 }),
    ])
    await printReceipt({ saleId: "sale_1", register: BACK.id })
    expect(api.sendPrintJob).toHaveBeenCalledWith(expect.objectContaining({ printer: "p_back" }))
  })

  it("uses this browser's own register when none is passed", async () => {
    device.register = BACK.id
    api.listPrinters.mockResolvedValue([
      printer(),
      printer({ id: "p_back", register: BACK.id, register_name: BACK.name }),
    ])
    await printReceipt({ saleId: "sale_1" })
    expect(api.sendPrintJob).toHaveBeenCalledWith(expect.objectContaining({ printer: "p_back" }))
  })

  it("uses the shop's default register, the first, when the browser has none", async () => {
    api.listPrinters.mockResolvedValue([
      printer({ id: "p_back", register: BACK.id, register_name: BACK.name }),
      printer(),
    ])
    await printReceipt({ saleId: "sale_1" })
    expect(api.sendPrintJob).toHaveBeenCalledWith(expect.objectContaining({ printer: "p_counter" }))
  })

  it("prefers a printer that is answering over one that is not", async () => {
    api.listPrinters.mockResolvedValue([
      printer({ id: "p_old", online: false }),
      printer({ id: "p_new", online: true }),
    ])
    await printReceipt({ saleId: "sale_1" })
    expect(api.sendPrintJob).toHaveBeenCalledWith(expect.objectContaining({ printer: "p_new" }))
  })

  it("ignores a printer that is switched off", async () => {
    api.listPrinters.mockResolvedValue([printer({ active: false })])
    const outcome = await printReceipt({ saleId: "sale_1" })
    expect(outcome.ok).toBe(false)
    expect(api.sendPrintJob).not.toHaveBeenCalled()
  })
})

describe("printReceipt with no printer", () => {
  beforeEach(() => {
    api.listPrinters.mockResolvedValue([])
  })

  it("opens the browser print page and says so in one line, naming the register", async () => {
    const outcome = await printReceipt({ saleId: "sale_1" })
    expect(open).toHaveBeenCalledWith("/print/receipt/sale_1", "_blank")
    expect(outcome).toEqual({
      ok: false,
      message: "No receipt printer is set up for Counter. Printing in the browser instead.",
    })
    expect(api.getReceipt).not.toHaveBeenCalled()
    expect(api.sendPrintJob).not.toHaveBeenCalled()
  })

  it("names the register that was asked for", async () => {
    const outcome = await printReceipt({ saleId: "sale_1", register: BACK.id })
    expect(outcome).toEqual({
      ok: false,
      message: "No receipt printer is set up for Back office. Printing in the browser instead.",
    })
  })

  it("carries the gift, refund and reprint choices to the browser page", async () => {
    await printReceipt({ saleId: "sale_1", gift: true, refundRef: "GG-S-000456-R1", reprint: true })
    expect(open).toHaveBeenCalledWith(
      "/print/receipt/sale_1?gift=1&refund=GG-S-000456-R1&reprint=1",
      "_blank"
    )
  })

  it("says to allow pop-ups when the browser would not open the page", async () => {
    open.mockReturnValue(null)
    const outcome = await printReceipt({ saleId: "sale_1" })
    expect(outcome.ok).toBe(false)
    expect(outcome).toMatchObject({
      message: expect.stringContaining("Allow pop-ups for this site if nothing opened."),
    })
  })
})

describe("printReceipt when something goes wrong", () => {
  it("passes on a sentence the server wrote", async () => {
    api.sendPrintJob.mockRejectedValue(
      new Error("That image is 800 pixels wide but Counter printer prints 576 across. Draw the receipt again at 576.")
    )
    const outcome = await printReceipt({ saleId: "sale_1" })
    expect(outcome).toEqual({
      ok: false,
      message:
        "That image is 800 pixels wide but Counter printer prints 576 across. Draw the receipt again at 576.",
    })
  })

  it("says what to do when the failure has no sentence of its own", async () => {
    api.getReceipt.mockRejectedValue(new TypeError("Failed to fetch"))
    const outcome = await printReceipt({ saleId: "sale_1" })
    expect(outcome.ok).toBe(false)
    expect(outcome).toMatchObject({ message: expect.stringContaining("print it again from the sale") })
  })

  it("never throws, so a paid sale is never held up by a printer", async () => {
    api.listPrinters.mockRejectedValue(new Error("offline"))
    await expect(printReceipt({ saleId: "sale_1" })).resolves.toMatchObject({ ok: false })
  })
})

describe("printTillReport", () => {
  it("draws the saved report and posts it as an X or Z report", async () => {
    const outcome = await printTillReport({ reportId: "z_1" })
    expect(outcome).toEqual({ ok: true, jobId: "job_1" })
    expect(api.getTillReport).toHaveBeenCalledWith("z_1")
    expect(painter.renderTillReportImage).toHaveBeenCalledWith(expect.anything(), { width: 576 })
    expect(api.sendPrintJob).toHaveBeenCalledWith({
      printer: "p_counter",
      kind: "z_report",
      ref: "z_1",
      image: IMAGE,
    })

    api.getTillReport.mockResolvedValue(sampleReport("x_1"))
    await printTillReport({ reportId: "x_1" })
    expect(api.sendPrintJob).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "x_report" }))
  })

  it("says to add a printer when the register has none, and does not open the browser", async () => {
    api.listPrinters.mockResolvedValue([])
    const outcome = await printTillReport({ reportId: "z_1" })
    expect(outcome).toEqual({
      ok: false,
      message: "No receipt printer is set up for Counter. Add one under Settings, Printers.",
    })
    expect(open).not.toHaveBeenCalled()
    expect(api.getTillReport).not.toHaveBeenCalled()
  })
})

describe("openDrawer", () => {
  it("kicks the drawer on the register that was passed", async () => {
    expect(await openDrawer(BACK.id)).toEqual({ ok: true, jobId: "job_drawer" })
    expect(api.sendDrawerKick).toHaveBeenCalledWith(BACK.id)
  })

  it("kicks this browser's register when none is passed", async () => {
    device.register = COUNTER.id
    await openDrawer()
    expect(api.sendDrawerKick).toHaveBeenCalledWith(COUNTER.id)
  })

  it("leaves the register to the server when the browser has none", async () => {
    await openDrawer()
    expect(api.sendDrawerKick).toHaveBeenCalledWith(undefined)
  })

  it("passes on the server's sentence when there is no printer", async () => {
    api.sendDrawerKick.mockRejectedValue(
      new Error("No receipt printer is set up for Counter. Add one under Settings, Printers.")
    )
    expect(await openDrawer()).toEqual({
      ok: false,
      message: "No receipt printer is set up for Counter. Add one under Settings, Printers.",
    })
  })

  it("points at the drawer key when it fails without a sentence", async () => {
    api.sendDrawerKick.mockRejectedValue(new TypeError("Failed to fetch"))
    const outcome = await openDrawer()
    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining("drawer key") })
  })
})

describe("browserReceiptUrl", () => {
  it("is the receipt's page with only the choices that were made", () => {
    expect(browserReceiptUrl({ saleId: "abc" })).toBe("/print/receipt/abc")
    expect(browserReceiptUrl({ saleId: "abc", gift: true })).toBe("/print/receipt/abc?gift=1")
    expect(browserReceiptUrl({ saleId: "a b" })).toBe("/print/receipt/a%20b")
  })
})
