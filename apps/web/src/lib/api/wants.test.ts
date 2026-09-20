import { beforeEach, describe, expect, it, vi } from "vitest"

const send = vi.fn()

vi.mock("@/lib/pb-customer", () => ({
  pbCustomer: {
    send: (...args: unknown[]) => send(...args),
    authStore: { token: "", record: null, isValid: false, clear: () => {} },
  },
  customerAuthId: () => "cust_1",
}))

vi.mock("@/lib/api/mode", () => ({ isDemo: () => false }))

const { addWant, listMyWants } = await import("@/lib/api/wants")

const CARD = { id: "card_1", name: "Charizard ex", set: "Scarlet & Violet 151", number: "199/165" }

beforeEach(() => {
  send.mockReset()
})

describe("listMyWants", () => {
  it("reads the route's rows, card and hold included", async () => {
    send.mockResolvedValue({
      rows: [
        {
          id: "w1",
          card: CARD,
          max_price: 25000,
          status: "matched",
          hold: {
            until: "2026-09-22T14:00:00Z",
            price: 23000,
            title: "Charizard ex 199/165",
          },
          created: "2026-09-10T10:00:00Z",
        },
      ],
    })

    const rows = await listMyWants()
    expect(send).toHaveBeenCalledWith("/api/vault/want-list", { method: "GET" })
    expect(rows[0]).toMatchObject({
      id: "w1",
      title: "Charizard ex",
      subtitle: "Scarlet & Violet 151 - 199/165",
      maxPrice: 25000,
      status: "matched",
    })
    expect(rows[0]!.hold).toEqual({
      until: "2026-09-22T14:00:00Z",
      price: 23000,
      title: "Charizard ex 199/165",
    })
  })

  it("calls a free-text row what the customer typed", async () => {
    send.mockResolvedValue({
      rows: [{ id: "w2", card: null, free_text: "Pokemon Snap, boxed", status: "open" }],
    })
    const [row] = await listMyWants()
    expect(row).toMatchObject({
      title: "Pokemon Snap, boxed",
      subtitle: "Typed in by you",
      maxPrice: null,
      hold: null,
    })
  })

  it("leaves a closed row off the list", async () => {
    send.mockResolvedValue({
      rows: [
        { id: "w1", card: CARD, status: "open" },
        { id: "w2", card: CARD, status: "closed" },
      ],
    })
    expect(await listMyWants()).toHaveLength(1)
  })

  it("reads a bare array too, rather than breaking on the wrapper", async () => {
    send.mockResolvedValue([{ id: "w1", card: CARD, status: "open" }])
    expect(await listMyWants()).toHaveLength(1)
  })

  it("answers an empty list rather than throwing on a shape it cannot read", async () => {
    send.mockResolvedValue({ nothing: true })
    expect(await listMyWants()).toEqual([])
  })
})

describe("addWant", () => {
  const display = { title: "Charizard ex", subtitle: "Scarlet & Violet 151 - 199/165" }

  it("unwraps the shipped { row } shape", async () => {
    send.mockResolvedValue({ row: { id: "w9", card: CARD, max_price: 6000, status: "open" } })
    const row = await addWant({ cardId: "card_1", maxPrice: 6000 }, display)
    expect(row).toMatchObject({ id: "w9", title: "Charizard ex", maxPrice: 6000 })
  })

  it("unwraps the earlier { want } draft", async () => {
    send.mockResolvedValue({ want: { id: "w9", card: CARD, status: "open" } })
    expect((await addWant({ cardId: "card_1", maxPrice: null }, display)).id).toBe("w9")
  })

  it("reads a bare record with no wrapper at all", async () => {
    send.mockResolvedValue({ id: "w9", card: CARD, status: "open" })
    expect((await addWant({ cardId: "card_1", maxPrice: null }, display)).id).toBe("w9")
  })

  it("sends only the fields that were filled in", async () => {
    send.mockResolvedValue({ row: { id: "w9", free_text: "Pokemon Snap", status: "open" } })
    await addWant({ freeText: "Pokemon Snap", maxPrice: null }, {
      title: "Pokemon Snap",
      subtitle: "Typed in by you",
    })
    expect(send).toHaveBeenCalledWith("/api/vault/want-list", {
      method: "POST",
      body: { free_text: "Pokemon Snap" },
    })
  })

  it("says what to do when the row cannot be read back", async () => {
    send.mockResolvedValue({ nothing: true })
    await expect(addWant({ cardId: "card_1", maxPrice: null }, display)).rejects.toThrow(
      /Reload/
    )
  })
})
