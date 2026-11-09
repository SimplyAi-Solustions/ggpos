import { describe, expect, it } from "vitest"

import {
  addPage,
  binderStats,
  buildPages,
  clearPockets,
  commit,
  diffLayouts,
  gridOf,
  HISTORY_LIMIT,
  initHistory,
  isEmptyDiff,
  layoutFrom,
  movePage,
  movePockets,
  pageCount,
  pageOfSlot,
  perPage,
  redo,
  reflowPage,
  removePage,
  setOwned,
  stripPrices,
  undo,
  type Layout,
} from "@/features/binders/layout"

const placed = (n: number, owned: number[] = []) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, slot: i, owned: owned.includes(i) }))

const slotsOf = (l: Layout) => Object.fromEntries(Object.entries(l.slots).sort())

describe("grids and paging", () => {
  it("knows each grid's pocket count and falls back to 3x3", () => {
    expect(perPage("2x2")).toBe(4)
    expect(perPage("3x3")).toBe(9)
    expect(perPage("3x4")).toBe(12)
    expect(perPage("4x4")).toBe(16)
    expect(gridOf("5x5")).toBe("3x3")
    expect(gridOf(undefined)).toBe("3x3")
  })

  it("pages the same cards differently per grid", () => {
    const l = layoutFrom(placed(20))
    expect(pageCount(l, "2x2")).toBe(5)
    expect(pageCount(l, "3x3")).toBe(3)
    expect(pageCount(l, "3x4")).toBe(2)
    expect(pageCount(l, "4x4")).toBe(2)
  })

  it("always has at least one page, and honours added empty pages", () => {
    expect(pageCount(layoutFrom([]), "3x3")).toBe(1)
    expect(pageCount(layoutFrom(placed(2), 18), "3x3")).toBe(2)
  })

  it("draws gaps as empty pockets in the all view", () => {
    const l = layoutFrom([
      { id: "a", slot: 0, owned: false },
      { id: "b", slot: 5, owned: true },
    ])
    const pages = buildPages([{ id: "a" }, { id: "b" }], l, "2x2", "all")
    expect(pages).toHaveLength(2)
    expect(pages[0].map((c) => c.pocket?.id ?? null)).toEqual(["a", null, null, null])
    expect(pages[1].map((c) => c.slot)).toEqual([4, 5, 6, 7])
    expect(pages[1][1].pocket?.id).toBe("b")
  })

  it("maps a page across a grid change to keep the same cards in view", () => {
    expect(reflowPage(2, "3x3", "4x4")).toBe(1)
    expect(reflowPage(1, "4x4", "2x2")).toBe(4)
    expect(pageOfSlot(17, "3x3")).toBe(1)
    expect(pageOfSlot(-1, "3x3")).toBe(0)
  })

  it("settles two pockets claiming one slot", () => {
    const l = layoutFrom([
      { id: "a", slot: 0, owned: false },
      { id: "b", slot: 0, owned: false },
      { id: "c", slot: 1, owned: false },
    ])
    expect(new Set(Object.values(l.slots)).size).toBe(3)
    expect(l.slots.a).toBe(0)
    expect(l.slots.b).toBe(2)
  })
})

describe("owned and needed filtering", () => {
  const pockets = placed(6).map((p) => ({ id: p.id }))
  const l = layoutFrom(placed(6, [1, 4]))

  it("packs owned cards in binder order", () => {
    const pages = buildPages(pockets, l, "2x2", "owned")
    expect(pages).toHaveLength(1)
    expect(pages[0].map((c) => c.pocket?.id ?? null)).toEqual(["p1", "p4", null, null])
    expect(pages[0][1].slot).toBe(4)
  })

  it("packs needed cards and pages them", () => {
    const pages = buildPages(pockets, l, "2x2", "needed")
    expect(pages.flat().filter((c) => c.pocket).map((c) => c.pocket?.id)).toEqual(["p0", "p2", "p3", "p5"])
    expect(pages).toHaveLength(1)
  })

  it("leaves taken-out cards out of every view", () => {
    const out = clearPockets(l, ["p1"])
    expect(buildPages(pockets, out, "2x2", "owned")[0][0].pocket?.id).toBe("p4")
    expect(
      buildPages(pockets, out, "3x3", "all")
        .flat()
        .some((c) => c.pocket?.id === "p1")
    ).toBe(false)
  })

  it("shows one empty page when nothing matches", () => {
    const pages = buildPages(pockets, layoutFrom(placed(6)), "3x3", "owned")
    expect(pages).toHaveLength(1)
    expect(pages[0].every((c) => c.pocket === null)).toBe(true)
  })
})

describe("pocket actions", () => {
  it("marks owned and needed, and ignores a no-op", () => {
    const l = layoutFrom(placed(3))
    const a = setOwned(l, ["p0", "p2"], true)
    expect(a.owned).toMatchObject({ p0: true, p1: false, p2: true })
    expect(setOwned(a, ["p0"], true)).toBe(a)
    expect(setOwned(a, ["p0", "p2"], false).owned.p2).toBe(false)
  })

  it("moves cards to an empty run of pockets", () => {
    const l = layoutFrom(placed(3))
    const m = movePockets(l, ["p0", "p1"], 10)
    expect(slotsOf(m)).toEqual({ p0: 10, p1: 11, p2: 2 })
  })

  it("swaps cards already in the destination into the freed pockets", () => {
    const l = layoutFrom(placed(6))
    const m = movePockets(l, ["p4", "p5"], 0)
    expect(slotsOf(m)).toEqual({ p0: 4, p1: 5, p2: 2, p3: 3, p4: 0, p5: 1 })
    expect(new Set(Object.values(m.slots)).size).toBe(6)
  })

  it("handles a move that overlaps its own pockets", () => {
    const l = layoutFrom(placed(4))
    const m = movePockets(l, ["p1", "p2"], 2)
    expect(slotsOf(m)).toEqual({ p0: 0, p1: 2, p2: 3, p3: 1 })
  })

  it("returns the same layout when nothing moves", () => {
    const l = layoutFrom(placed(3))
    expect(movePockets(l, ["p0", "p1"], 0)).toBe(l)
    expect(movePockets(l, [], 4)).toBe(l)
  })
})

describe("page operations", () => {
  it("adds a page at the end and inserts one in the middle", () => {
    const l = layoutFrom(placed(10))
    const end = addPage(l, "3x3")
    expect(pageCount(end, "3x3")).toBe(3)
    expect(slotsOf(end)).toEqual(slotsOf(l))
    const mid = addPage(l, "3x3", 1)
    expect(mid.slots.p9).toBe(18)
    expect(mid.slots.p8).toBe(8)
  })

  it("removes a page, keeps its cards for undo, and closes the gap", () => {
    const l = layoutFrom(placed(12))
    const r = removePage(l, "2x2", 1)
    expect(r.slots.p4).toBe(-1)
    expect(r.slots.p7).toBe(-1)
    expect(r.slots.p8).toBe(4)
    expect(pageCount(r, "2x2")).toBe(2)
  })

  it("never removes the last page", () => {
    const l = layoutFrom(placed(2))
    expect(removePage(l, "3x3", 0)).toBe(l)
  })

  it("reorders pages", () => {
    const l = layoutFrom(placed(12))
    const m = movePage(l, "2x2", 2, 0)
    expect(m.slots.p8).toBe(0)
    expect(m.slots.p0).toBe(4)
    expect(m.slots.p4).toBe(8)
    expect(movePage(l, "2x2", 1, 1)).toBe(l)
  })
})

describe("undo and redo", () => {
  it("walks back and forward through actions", () => {
    let h = initHistory(layoutFrom(placed(4)))
    const start = h.present
    h = commit(h, setOwned(h.present, ["p0"], true))
    h = commit(h, movePockets(h.present, ["p3"], 0))
    expect(h.past).toHaveLength(2)
    h = undo(h)
    expect(h.present.slots.p3).toBe(3)
    expect(h.present.owned.p0).toBe(true)
    h = undo(h)
    expect(h.present).toBe(start)
    expect(undo(h)).toBe(h)
    h = redo(redo(h))
    expect(h.present.slots.p3).toBe(0)
    expect(redo(h)).toBe(h)
  })

  it("drops the redo stack on a new action and ignores no-ops", () => {
    let h = initHistory(layoutFrom(placed(2)))
    h = commit(h, setOwned(h.present, ["p0"], true))
    h = undo(h)
    expect(h.future).toHaveLength(1)
    h = commit(h, setOwned(h.present, ["p1"], true))
    expect(h.future).toHaveLength(0)
    expect(commit(h, h.present)).toBe(h)
  })

  it("keeps at most the history limit", () => {
    let h = initHistory(layoutFrom(placed(1)))
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) h = commit(h, setOwned(h.present, ["p0"], i % 2 === 0))
    expect(h.past).toHaveLength(HISTORY_LIMIT)
  })

  it("diffs only what changed, so undo sends the reverse change", () => {
    const a = layoutFrom(placed(3))
    const b = movePockets(setOwned(a, ["p1"], true), ["p2"], 7)
    expect(diffLayouts(a, b)).toEqual({
      pockets: [
        { id: "p1", owned: true },
        { id: "p2", slot: 7 },
      ],
    })
    expect(diffLayouts(b, a).pockets).toEqual([
      { id: "p1", owned: false },
      { id: "p2", slot: 2 },
    ])
    expect(isEmptyDiff(diffLayouts(a, a))).toBe(true)
    expect(diffLayouts(a, addPage(a, "3x3")).min_slots).toBe(18)
  })
})

describe("stats", () => {
  const card = (id: string, number: string, set = "sv1", total = "3") => ({
    id,
    number,
    set_id: set,
    set_name: set.toUpperCase(),
    set_total: total,
  })

  it("counts filled pockets and main set completion, secret rares apart", () => {
    const pockets = [card("a", "1"), card("b", "2"), card("c", "3"), card("d", "4")]
    const l = setOwned(
      layoutFrom(pockets.map((p, i) => ({ id: p.id, slot: i, owned: false }))),
      ["a", "d"],
      true
    )
    const s = binderStats(pockets, l, "set")
    expect(s.filled).toBe(2)
    expect(s.total).toBe(4)
    expect(s.mainSet).toEqual({ got: 1, total: 3 })
  })

  it("ranks sets by completion for other binders and skips taken-out cards", () => {
    const pockets = [card("a", "1", "x"), card("b", "2", "x"), card("c", "1", "y")]
    let l = layoutFrom(pockets.map((p, i) => ({ id: p.id, slot: i, owned: false })))
    l = setOwned(l, ["c"], true)
    const s = binderStats(pockets, l, "pokemon")
    expect(s.mainSet).toBeNull()
    expect(s.sets[0]).toMatchObject({ set_id: "y", got: 1, total: 1 })
    expect(s.setsComplete).toBe(1)
    const out = binderStats(pockets, clearPockets(l, ["a"]), "pokemon")
    expect(out.total).toBe(2)
  })
})

describe("stripPrices", () => {
  it("removes every price-like key at any depth", () => {
    const dirty = {
      id: "p1",
      name: "Pikachu",
      price: 199,
      pricing: { cardmarket: { avg: 1.2 } },
      nested: [{ market_value_pence: 5, image: "x" }],
      tcgplayer: {},
      sell_offer: 1,
    }
    expect(stripPrices(dirty)).toEqual({ id: "p1", name: "Pikachu", nested: [{ image: "x" }] })
  })

  it("leaves plain values and identity fields alone", () => {
    expect(stripPrices(3)).toBe(3)
    expect(stripPrices(null)).toBeNull()
    expect(stripPrices([{ card_id: "a", set_total: "102", owned: true }])).toEqual([
      { card_id: "a", set_total: "102", owned: true },
    ])
  })
})
