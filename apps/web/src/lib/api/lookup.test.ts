import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The lookup routes, against a stubbed client.
 *
 * Two things here are easy to get wrong and invisible until a card goes
 * missing: what a manual card is written with, and which platform a retro
 * row is drawn as.
 */

const send = vi.fn()
const create = vi.fn()
const getFirstListItem = vi.fn()
const getFullList = vi.fn()

vi.mock("@/lib/pb", () => ({
  pb: {
    send: (path: string, options: unknown) => send(path, options),
    collection: (name: string) => ({
      create: (body: unknown) => create(name, body),
      getFirstListItem: (filter: string, options?: unknown) =>
        getFirstListItem(name, filter, options),
      getFullList: (options?: unknown) => getFullList(name, options),
    }),
    files: { getURL: () => "https://example.test/cover.webp" },
    authStore: { record: { id: "staff_demo" } },
  },
  pingPocketBase: async () => true,
}))

const { setDataMode } = await import("@/lib/api/mode")
const { createManualCard, searchRetro } = await import("@/lib/api/lookup")

beforeEach(() => {
  setDataMode(false)
  send.mockReset()
  create.mockReset()
  getFirstListItem.mockReset()
  getFullList.mockReset()
  getFullList.mockResolvedValue([])
})

describe("createManualCard", () => {
  beforeEach(() => {
    getFirstListItem.mockImplementation(async (name: string) => {
      if (name === "games") return { id: "game_pokemon", key: "pokemon" }
      if (name === "card_sets") return { id: "set_1", code: "sv151", name: "151" }
      throw new Error("not found")
    })
    create.mockResolvedValue({ id: "card_new" })
  })

  it("writes the card as manual, and stamps it as synced now", async () => {
    const before = Date.now()
    await createManualCard({
      gameKey: "pokemon",
      name: "Charizard ex",
      setCode: "sv151",
      number: "199/165",
    })

    const [collection, body] = create.mock.calls[0] as [string, Record<string, string>]
    expect(collection).toBe("cards")
    expect(body.source).toBe("manual")
    expect(body.name).toBe("Charizard ex")
    expect(body.number).toBe("199/165")
    expect(body.search_text).toContain("charizard")
    // Without a stamp the exact lookup treats the row as long out of date,
    // asks the adapter about a card only this shop knows, gets nothing, and
    // answers 404 for a card that is right there.
    expect(new Date(body.last_synced).getTime()).toBeGreaterThanOrEqual(before)
  })

  it("creates the set when the shop has never seen that code", async () => {
    getFirstListItem.mockImplementation(async (name: string) => {
      if (name === "games") return { id: "game_pokemon", key: "pokemon" }
      throw new Error("not found")
    })
    create.mockImplementation(async (name: string) =>
      name === "card_sets" ? { id: "set_new", code: "zzz", name: "ZZZ" } : { id: "card_new" }
    )

    const hit = await createManualCard({
      gameKey: "pokemon",
      name: "Promo",
      setCode: "zzz",
      number: "1",
    })

    expect(create.mock.calls[0]?.[0]).toBe("card_sets")
    expect(hit.setCode).toBe("zzz")
    expect(hit.gameKey).toBe("pokemon")
  })
})

describe("searchRetro", () => {
  it("draws a row in its own platform, whatever the search asked for", async () => {
    // A search with no platform is preview-only, but rows the shop already
    // holds come back with a real platform id: reading it keeps a SNES box
    // out of the 3:4 "Other" frame.
    getFullList.mockResolvedValue([{ id: "plat_snes", key: "snes_pal_box" }])
    send.mockResolvedValue({
      titles: [
        {
          id: "retro_smk",
          platform: "plat_snes",
          name: "Super Mario Kart",
          region: "PAL",
          cover: "cover.webp",
          external_ids: {},
        },
      ],
    })

    const [hit] = await searchRetro("mario")
    expect(hit?.platformKey).toBe("snes_pal_box")
    expect(hit?.platformName).toBe("SNES PAL box")
    expect(hit?.image).toBe("https://example.test/cover.webp")
  })

  it("falls back to the platform that was asked for", async () => {
    getFullList.mockResolvedValue([])
    send.mockResolvedValue({
      titles: [
        {
          id: "",
          platform: "",
          name: "GoldenEye 007",
          region: "",
          cover: "",
          external_ids: {},
        },
      ],
    })

    const [hit] = await searchRetro("goldeneye", "n64_box")
    expect(hit?.platformKey).toBe("n64_box")
    expect(hit?.image).toBeUndefined()
  })
})
