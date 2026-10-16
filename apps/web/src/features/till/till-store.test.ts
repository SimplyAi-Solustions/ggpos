import { beforeEach, describe, expect, it } from "vitest"

import { lineFromCatalogueItem } from "@/features/till/ticket"
import {
  configureTillStore,
  dispatchTill,
  getTill,
  storageKey,
  tillClientId,
  tillReducer,
  emptyTill,
} from "@/features/till/till-store"

/** sessionStorage, as the store sees it, without a browser. */
function memory() {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  }
}

const BOOSTER = lineFromCatalogueItem({
  id: "item_booster",
  sku: "GGP5N2W8H",
  title: "Booster pack",
  price: 549,
  qty: 30,
  image_url: "",
  kind: "sealed",
  status: "in_stock",
})

describe("the till's ticket store", () => {
  let store: ReturnType<typeof memory>

  beforeEach(() => {
    store = memory()
    configureTillStore({ register: "register_counter", storage: store })
  })

  it("keeps the ticket under the register's own key", () => {
    dispatchTill({ type: "add", line: BOOSTER })
    expect(store.data.has(storageKey("register_counter"))).toBe(true)
    expect(storageKey(undefined)).toBe("gg.till.ticket.default")
  })

  it("survives a reload: a fresh read finds the same ticket and tenders", () => {
    dispatchTill({ type: "add", line: BOOSTER })
    dispatchTill({ type: "add", line: BOOSTER })
    dispatchTill({ type: "pay" })
    dispatchTill({
      type: "setTenders",
      tenders: [{ id: "t1", method: "card_tide", amount: 549, card_last4: "4242" }],
    })
    const id = tillClientId()

    // Another page load: the same storage, read from scratch.
    configureTillStore({ register: "register_counter", storage: store })
    const after = getTill()
    expect(after.ticket.lines[0]?.qty).toBe(2)
    expect(after.phase).toBe("paying")
    expect(after.tenders).toHaveLength(1)
    expect(tillClientId()).toBe(id)
  })

  it("keeps each register's ticket apart", () => {
    dispatchTill({ type: "add", line: BOOSTER })
    configureTillStore({ register: "register_back_room", storage: store })
    expect(getTill().ticket.lines).toHaveLength(0)
    configureTillStore({ register: "register_counter", storage: store })
    expect(getTill().ticket.lines).toHaveLength(1)
  })

  it("mints one client id per sale, and a new one for the next", () => {
    dispatchTill({ type: "add", line: BOOSTER })
    const first = tillClientId()
    expect(tillClientId()).toBe(first)
    dispatchTill({ type: "newSale" })
    expect(tillClientId()).not.toBe(first)
  })

  it("drops a saved ticket it cannot read rather than half-trusting it", () => {
    store.data.set(storageKey("register_counter"), "{not json")
    configureTillStore({ register: "register_counter", storage: store })
    expect(getTill()).toEqual(emptyTill())
  })
})

describe("the till's phases", () => {
  it("goes from the ticket to paying and back, and only from the ticket", () => {
    let state = tillReducer(emptyTill(), { type: "add", line: BOOSTER })
    state = tillReducer(state, { type: "pay" })
    expect(state.phase).toBe("paying")
    state = tillReducer(state, { type: "openStep", step: "cash" })
    state = tillReducer(state, { type: "backToTicket" })
    expect(state.phase).toBe("ticket")
    expect(state.step).toBeNull()
  })

  it("starts the next sale when anything is added after one is done", () => {
    let state = tillReducer(emptyTill(), { type: "add", line: BOOSTER })
    state = tillReducer(state, {
      type: "completed",
      done: {
        saleId: "sale_1",
        number: "GG-S-000457",
        total: 549,
        change: 0,
        pointsEarned: 0,
        cash: false,
        queued: false,
      },
    })
    expect(state.phase).toBe("done")
    state = tillReducer(state, { type: "add", line: BOOSTER })
    expect(state.phase).toBe("ticket")
    expect(state.done).toBeNull()
    expect(state.ticket.lines[0]?.qty).toBe(1)
  })

  it("puts a recalled ticket on an empty till", () => {
    const parked = tillReducer(emptyTill(), { type: "add", line: BOOSTER }).ticket
    const state = tillReducer(emptyTill(), { type: "recall", ticket: parked })
    expect(state.ticket.lines).toHaveLength(1)
    expect(state.phase).toBe("ticket")
  })
})
