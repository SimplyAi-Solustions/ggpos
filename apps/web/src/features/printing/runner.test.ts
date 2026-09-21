import { describe, expect, it, vi } from "vitest"
import { ClientResponseError } from "pocketbase"

import { printRun, shortError } from "@/features/printing/runner"
import { PrinterError } from "@/features/printing/usb"
import type { LabelJobDetail } from "@/lib/api/types"

function job(id: string): LabelJobDetail {
  return {
    id,
    status: "printing",
    copies: 1,
    template: "toploader_40x20",
    itemId: `item_${id}`,
    code: "GGS7F3K2B",
    title: "Charizard ex",
    detail: "SV151 199/165 Holo",
    condition: "NM",
    price: 32499,
    requestedAt: "",
  }
}

/** What the runner is handed: a printer, and the two ways to report a job. */
function calls(
  overrides: Partial<Parameters<typeof printRun>[1]> = {}
): Parameters<typeof printRun>[1] & {
  sent: string[]
  printed: string[]
  failed: [string, string][]
} {
  const sent: string[] = []
  const printed: string[] = []
  const failed: [string, string][] = []
  return {
    sent,
    printed,
    failed,
    send: async (one) => {
      sent.push(one.id)
    },
    markPrinted: async (id) => {
      printed.push(id)
    },
    markFailed: async (id, error) => {
      failed.push([id, error])
    },
    // No real waiting between tries.
    wait: async () => {},
    ...overrides,
  }
}

describe("a run that goes through", () => {
  it("sends every label and reports each one", async () => {
    const run = calls()
    const result = await printRun([job("a"), job("b")], run)

    expect(run.sent).toEqual(["a", "b"])
    expect(run.printed).toEqual(["a", "b"])
    expect(run.failed).toEqual([])
    expect(result).toMatchObject({ printed: 2, error: null, printerLost: false })
    expect(result.unreported).toEqual([])
  })

  it("prints before it reports, never the other way round", async () => {
    const order: string[] = []
    const run = calls({
      send: async (one) => {
        order.push(`send ${one.id}`)
      },
      markPrinted: async (id) => {
        order.push(`printed ${id}`)
      },
    })
    await printRun([job("a")], run)
    expect(order).toEqual(["send a", "printed a"])
  })
})

describe("a label that did not print", () => {
  it("is marked failed, and the rest of the batch is handed back", async () => {
    const run = calls({
      send: async (one) => {
        if (one.id === "b") throw new PrinterError("failed")
        run.sent.push(one.id)
      },
    })
    const result = await printRun([job("a"), job("b"), job("c"), job("d")], run)

    expect(run.printed).toEqual(["a"])
    // b failed with the printer's own sentence; c and d go back to the queue
    // rather than sitting as "printing" on every screen in the shop.
    expect(run.failed.map(([id]) => id)).toEqual(["b", "c", "d"])
    expect(run.failed[1]?.[1]).toBe("The printer stopped part way through the run")
    expect(result).toMatchObject({ printed: 1, printerLost: false })
    expect(result.error).toContain("The printer would not take the label")
  })

  it("stops auto-print where the printer itself has gone", async () => {
    const run = calls({
      send: async () => {
        throw new PrinterError("disconnected")
      },
    })
    const result = await printRun([job("a")], run)
    expect(result.printerLost).toBe(true)
    expect(result.printed).toBe(0)
  })

  it("keeps the reason inside what the server will store", async () => {
    const long = `${"x".repeat(400)}`
    const run = calls({
      send: async () => {
        throw new Error(long)
      },
    })
    await printRun([job("a")], run)
    expect(run.failed[0]?.[1].length).toBe(300)
    expect(shortError(long).endsWith("...")).toBe(true)
    expect(shortError("short")).toBe("short")
  })
})

describe("a label that did print", () => {
  it("is never requeued because the report did not get through", async () => {
    let tries = 0
    const run = calls({
      markPrinted: async (id) => {
        tries += 1
        if (tries < 3) throw new TypeError("Failed to fetch")
        run.printed.push(id)
      },
    })
    const result = await printRun([job("a")], run)

    expect(tries).toBe(3)
    expect(run.printed).toEqual(["a"])
    expect(run.failed).toEqual([])
    expect(result.printed).toBe(1)
  })

  it("is left for the next pump when the connection stays down", async () => {
    const run = calls({
      markPrinted: async () => {
        throw new TypeError("Failed to fetch")
      },
    })
    const result = await printRun([job("a")], run)

    // The one thing that must never happen: the job back in the queue and
    // the same label out of the printer twice.
    expect(run.failed).toEqual([])
    expect(result.unreported).toEqual(["a"])
    expect(result.printed).toBe(1)
    expect(result.error).toBe(
      "The label printed but the queue was not told. It will be marked printed when the connection comes back."
    )
  })

  it("shows the server's own words when it refuses the report", async () => {
    const refusal = new ClientResponseError({
      status: 409,
      response: {
        code: 409,
        message:
          "That label went back in the queue, so another device may have printed it. Check the label before printing it again.",
        data: {},
      },
    })
    const markPrinted = vi.fn(async () => {
      throw refusal
    })
    const run = calls({ markPrinted })
    const result = await printRun([job("a")], run)

    // One try, because a refusal is an answer rather than a dropped line.
    expect(markPrinted).toHaveBeenCalledTimes(1)
    expect(run.failed).toEqual([])
    expect(result.unreported).toEqual([])
    expect(result.error).toContain("another device may have printed it")
    expect(result.printed).toBe(1)
  })

  it("carries on to the rest of the batch after a refused report", async () => {
    const run = calls({
      markPrinted: async (id) => {
        if (id === "a") {
          throw new ClientResponseError({
            status: 409,
            response: { code: 409, message: "That label went back in the queue.", data: {} },
          })
        }
        run.printed.push(id)
      },
    })
    const result = await printRun([job("a"), job("b")], run)
    expect(run.sent).toEqual(["a", "b"])
    expect(run.printed).toEqual(["b"])
    expect(result.printed).toBe(2)
  })
})
