import { ClientResponseError } from "pocketbase"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The offline wrappers the counter's screens actually call.
 *
 * The client id is the point: it is minted before the first attempt, sent
 * with it, and kept for the retry, so a sale the server took but whose
 * reply never came back is sent again as the same sale rather than ringing
 * the basket up twice.
 */

const completeSale = vi.fn()
const getSale = vi.fn()
const queueLabels = vi.fn()

vi.mock("@/lib/api/sales", () => ({
  completeSale: (payload: unknown) => completeSale(payload),
  getSale: (id: string) => getSale(id),
}))
vi.mock("@/lib/api/labels", () => ({
  queueLabels: (ids: string[], template?: string) => queueLabels(ids, template),
}))
vi.mock("@/lib/pb", () => ({
  pb: { collection: () => ({ getOne: async () => null }), authStore: { record: null } },
  pingPocketBase: async () => true,
}))

const { setDataMode } = await import("@/lib/api/mode")
const { resetNet, setSimulatedOffline } = await import("@/lib/offline/net")
const { queueSnapshot, resetQueue } = await import("@/lib/offline/queue")
const { memoryStore } = await import("@/lib/offline/store")
const { completeSaleQueued, getSaleQueued, OfflineQueuedError, QUEUED_SALE_NUMBER } =
  await import("@/lib/api/offline")
const { registerSender } = await import("@/lib/offline/queue")

const PAYLOAD = {
  lines: [{ item: "item_1", qty: 1, unit_price: 32499, discount: 0 }],
  customer: null,
  payment: "cash" as const,
  payment_split: { cash: 32499 },
  discount: 0,
  discount_source: null,
  reward_code: null,
  cash_session: "cash_1",
  sumup_ref: "",
}

/** A request that never reached anybody. */
function dropped() {
  return new ClientResponseError({ status: 0, response: {}, isAbort: false })
}

describe("completing a sale with the line down", () => {
  beforeEach(async () => {
    setDataMode(false)
    resetNet()
    await resetQueue(memoryStore())
    // The queue's own sender is registered when lib/api/offline loads; put
    // it back after resetQueue cleared it.
    registerSender(async (entry) => {
      if (entry.work.kind === "mark_sold") await completeSale(entry.work.body)
    })
    completeSale.mockReset()
    getSale.mockReset()
    queueLabels.mockReset()
  })

  it("sends a client id on the very first attempt", async () => {
    completeSale.mockResolvedValue({ sale: { id: "sale_1", number: "GG-S-000457" } })

    await completeSaleQueued(PAYLOAD)

    const sent = completeSale.mock.calls[0]![0] as { client_id?: string }
    expect(sent.client_id).toMatch(/\w/)
  })

  it("keeps the same id when it has to queue after a failed send", async () => {
    completeSale.mockRejectedValue(dropped())

    const result = await completeSaleQueued(PAYLOAD)

    const tried = completeSale.mock.calls[0]![0] as { client_id: string }
    const queued = queueSnapshot().pending[0]!
    expect(queued.id).toBe(tried.client_id)
    expect((queued.work as { body: { client_id: string } }).body.client_id).toBe(
      tried.client_id
    )
    expect(result.sale.number).toBe(QUEUED_SALE_NUMBER)
    expect(result.sale.total).toBe(32499)
  })

  it("queues without trying at all when the counter is already offline", async () => {
    setSimulatedOffline(true)

    const result = await completeSaleQueued(PAYLOAD)

    expect(completeSale).not.toHaveBeenCalled()
    expect(queueSnapshot().pending).toHaveLength(1)
    expect(result.sale.id.startsWith("queued:")).toBe(true)
    // Nothing guesses at the server's arithmetic.
    expect(result.points_earned).toBe(0)
    setSimulatedOffline(false)
  })

  it("throws a refusal straight through rather than queueing it", async () => {
    completeSale.mockRejectedValue(
      new ClientResponseError({
        status: 409,
        response: { code: 409, message: "That item is already sold." },
      })
    )

    await expect(completeSaleQueued(PAYLOAD)).rejects.toThrow("That item is already sold.")
    expect(queueSnapshot().pending).toHaveLength(0)
  })

  it("says why a sale that has not gone cannot be undone", async () => {
    await expect(getSaleQueued("queued:abc")).rejects.toBeInstanceOf(OfflineQueuedError)
    await expect(getSaleQueued("queued:abc")).rejects.toThrow(
      /still waiting to send/
    )
    expect(getSale).not.toHaveBeenCalled()
  })

  it("reads a real sale back as normal", async () => {
    getSale.mockResolvedValue({ id: "sale_1", lines: [] })

    await expect(getSaleQueued("sale_1")).resolves.toEqual({ id: "sale_1", lines: [] })
  })
})
