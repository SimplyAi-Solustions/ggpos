import { describe, expect, it } from "vitest"
import * as lib from "@mmote/niimbluelib"
import type { ImageSource, PrintOptions, PrintTaskName } from "@mmote/niimbluelib"

import {
  densityFor,
  describeLabelPrinterError,
  LABEL_PRINTER_MESSAGES,
  LabelPrinterError,
  printOnClient,
  type PrinterClientLike,
  type PrintTaskLike,
} from "./niimbot"

/** A 320 x 96 label with a black bar down its left edge. */
function label(width = 320, height = 96): ImageSource {
  return {
    width,
    height,
    getPixelColor(x: number, y: number, direction: "left" | "top" = "left") {
      // The library asks in printer rows; turn that back into a canvas pixel.
      const [cx] = direction === "left" ? [y, height - 1 - x] : [x, y]
      return cx < 8 ? 0x000000 : 0xffffff
    },
  }
}

interface Recorded {
  calls: string[]
  options: Partial<PrintOptions> | undefined
  taskName: PrintTaskName | undefined
  pages: { rows: number; cols: number; quantity: number | undefined }[]
}

function fakeClient(opts: { connected?: boolean; failOnPage?: number; failWith?: unknown } = {}) {
  const record: Recorded = { calls: [], options: undefined, taskName: undefined, pages: [] }
  let connected = opts.connected ?? true
  const task: PrintTaskLike = {
    async printInit() {
      record.calls.push("init")
    },
    async printPage(image, quantity) {
      record.calls.push(`page ${record.pages.length + 1}`)
      if (opts.failOnPage === record.pages.length + 1) {
        if (opts.failWith === "drop") connected = false
        throw opts.failWith === "drop" ? new Error("Channel is closed") : opts.failWith
      }
      record.pages.push({ rows: image.rows, cols: image.cols, quantity })
    },
    async waitForPageFinished() {
      record.calls.push("wait page")
    },
    async waitForFinished() {
      record.calls.push("wait all")
    },
    async printEnd() {
      record.calls.push("end")
      return true
    },
  }
  const client: PrinterClientLike = {
    protocol: {
      newPrintTask(name, options) {
        record.calls.push("task")
        record.taskName = name
        record.options = options
        return task
      },
    },
    getModelMetadata: () => ({ printDirection: "left", densityMin: 1, densityMax: 3, densityDefault: 2 }),
    getPrintTaskType: () => "D110",
    isConnected: () => connected,
    stopHeartbeat: () => record.calls.push("heartbeat off"),
    startHeartbeat: () => record.calls.push("heartbeat on"),
  }
  return { client, record }
}

describe("printing price labels on the D110", () => {
  it("sends each label with its copies, waits for each, and ends the print", async () => {
    const { client, record } = fakeClient()
    const progress: string[] = []
    const printed = await printOnClient(
      lib,
      client,
      [
        { source: label(), copies: 2 },
        { source: label(), copies: 0 },
        { source: label(), copies: 3 },
      ],
      "normal",
      (done, total) => progress.push(`${done}/${total}`)
    )

    expect(printed).toBe(5)
    expect(progress).toEqual(["2/5", "5/5"])
    expect(record.calls).toEqual([
      "heartbeat off",
      "task",
      "init",
      "page 1",
      "wait page",
      "page 2",
      "wait page",
      "wait all",
      "end",
      "heartbeat on",
    ])
    expect(record.taskName).toBe("D110")
    expect(record.options).toMatchObject({
      totalPages: 5,
      density: 2,
      labelType: lib.LabelType.WithGaps,
      pageColor: lib.PageColorType.SingleColor,
    })
    expect(record.pages.map((page) => page.quantity)).toEqual([2, 3])
  })

  it("turns the 40 mm landscape a quarter so 96 dots cross the head and 320 rows feed", async () => {
    const { client, record } = fakeClient()
    await printOnClient(lib, client, [{ source: label(), copies: 1 }], "normal")
    expect(record.pages[0]).toMatchObject({ rows: 320, cols: 96 })
  })

  it("ends the print and says how many came out when the printer refuses part way", async () => {
    const { client, record } = fakeClient({
      failOnPage: 2,
      failWith: Object.assign(new Error("Print error 1"), { reasonId: 1 }),
    })
    const failure = await printOnClient(
      lib,
      client,
      [
        { source: label(), copies: 4 },
        { source: label(), copies: 2 },
      ],
      "normal"
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(LabelPrinterError)
    expect(failure).toMatchObject({ fault: "cover_open", printed: 4 })
    expect(record.calls.slice(-2)).toEqual(["end", "heartbeat on"])
  })

  it("leaves the heartbeat off when the printer has gone, and calls it a dropped connection", async () => {
    const { client, record } = fakeClient({ failOnPage: 1, failWith: "drop" })
    const failure = await printOnClient(lib, client, [{ source: label(), copies: 1 }], "dark").catch(
      (error: unknown) => error
    )
    expect(failure).toMatchObject({ fault: "disconnected", printed: 0 })
    expect(record.calls).not.toContain("heartbeat on")
    expect(record.options?.density).toBe(3)
  })

  it("asks for a connection first, and prints nothing for no labels", async () => {
    const offline = fakeClient({ connected: false })
    await expect(printOnClient(lib, offline.client, [{ source: label(), copies: 1 }], "normal")).rejects.toMatchObject({
      fault: "not_connected",
    })
    expect(offline.record.calls).toEqual([])

    const idle = fakeClient()
    expect(await printOnClient(lib, idle.client, [{ source: label(), copies: 0 }], "normal")).toBe(0)
    expect(idle.record.calls).toEqual([])
  })
})

describe("the printer's darkness", () => {
  it("follows the model's own density range", () => {
    const d110 = { densityMin: 1, densityMax: 3, densityDefault: 2 }
    expect(densityFor("light", d110)).toBe(1)
    expect(densityFor("normal", d110)).toBe(2)
    expect(densityFor("dark", d110)).toBe(3)
    expect(densityFor("dark", { densityMin: 1, densityMax: 5, densityDefault: 3 })).toBe(5)
    expect(densityFor("normal", undefined)).toBe(2)
  })
})

describe("what the counter says when the printer will not", () => {
  const named = (name: string, message = "") => Object.assign(new Error(message), { name })

  it("tells a closed list from Bluetooth being off", () => {
    expect(describeLabelPrinterError(named("NotFoundError", "User cancelled the requestDevice() chooser."), "connect").fault).toBe(
      "cancelled"
    )
    expect(describeLabelPrinterError(named("NotFoundError", "Bluetooth adapter not available."), "connect").fault).toBe(
      "bluetooth_off"
    )
  })

  it("points at the Mac's Bluetooth permission when the browser is refused", () => {
    expect(describeLabelPrinterError(named("NotAllowedError", "Permission denied."), "connect").fault).toBe(
      "not_allowed"
    )
  })

  it("reads a lost connection by when it happened", () => {
    const gatt = named("NetworkError", "GATT Server is disconnected.")
    expect(describeLabelPrinterError(gatt, "connect").fault).toBe("no_answer")
    expect(describeLabelPrinterError(gatt, "print", 3)).toMatchObject({ fault: "disconnected", printed: 3 })
    expect(describeLabelPrinterError(new Error("Timeout waiting print status"), "print").fault).toBe("timeout")
  })

  it("reads the printer's own reasons", () => {
    const reason = (id: number) => describeLabelPrinterError(Object.assign(new Error("x"), { reasonId: id }), "print").fault
    expect(reason(2)).toBe("no_labels")
    expect(reason(3)).toBe("battery")
    expect(reason(9)).toBe("busy")
    expect(reason(99)).toBe("failed")
  })

  it("keeps to the copy rules", () => {
    for (const message of Object.values(LABEL_PRINTER_MESSAGES)) {
      expect(message).not.toMatch(/[!—]/)
      expect(message.endsWith(".")).toBe(true)
    }
  })
})
