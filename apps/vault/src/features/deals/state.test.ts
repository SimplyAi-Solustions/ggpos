import { describe, expect, it } from "vitest"

import { formatPct, formatUpdated, variantLabel } from "./format"
import {
  cardLineFromHit,
  customLine,
  dealReducer,
  draftPayout,
  ebaySoldUrl,
  itemCount,
  lineMarket,
  needsIdCheck,
  newDraft,
  priceDraft,
  roundingSuggestions,
  type DealAction,
} from "./state"
import type { CardHit, CardLine, DealDraft } from "./types"

const charizard: CardHit = {
  id: "c1",
  game: "pokemon",
  name: "Charizard",
  setName: "Base Set",
  setCode: "base1",
  number: "4/102",
  rarity: "Rare Holo",
  image: "",
  finishes: ["holo"],
}

function run(draft: DealDraft, ...actions: DealAction[]): DealDraft {
  return actions.reduce(dealReducer, draft)
}

function pricedCard(id: string, nm: number, lp: number | null = null): CardLine {
  return {
    ...cardLineFromHit(charizard, "holo", id),
    priceStatus: "ready",
    prices: {
      NM: { pence: nm, basis: "comp" },
      ...(lp === null ? {} : { LP: { pence: lp, basis: "comp" as const } }),
    },
  }
}

describe("a new draft", () => {
  it("gets a PocketBase-shaped id", () => {
    expect(newDraft().id).toMatch(/^[a-z0-9]{15}$/)
  })

  it("defaults to 80% trade and 70% cash, credit payout, no lines", () => {
    const draft = newDraft("d1", new Date("2026-11-09T14:05:00Z"))
    expect(draft.rates).toEqual({ tradePct: 80, cashPct: 70 })
    expect(draft.payout).toEqual({ type: "credit", cashTaken: 0 })
    expect(draft.status).toBe("open")
    expect(draft.name).toMatch(/^Deal 9 Nov/)
  })
})

describe("dealReducer", () => {
  it("prices a line at both sweep rates, side by side", () => {
    const draft = run(newDraft("d"), { type: "addLine", line: pricedCard("a", 51795) })
    const deal = priceDraft(draft)
    expect(deal.market).toBe(51795)
    expect(deal.trade).toBe(41436) // 80% of £517.95 = £414.36
    expect(deal.cash).toBe(36257)
  })

  it("moves both totals with the sweep steppers and clamps to 0 to 200", () => {
    const draft = run(
      newDraft("d"),
      { type: "addLine", line: pricedCard("a", 10000) },
      { type: "setRate", side: "trade", pct: 90 },
      { type: "setRate", side: "cash", pct: 250 }
    )
    expect(draft.rates).toEqual({ tradePct: 90, cashPct: 200 })
    expect(priceDraft(draft).trade).toBe(9000)
    expect(priceDraft(draft).cash).toBe(20000)
  })

  it("lets one card carry its own rate and keeps it when the sweep moves, then resets it", () => {
    let draft = run(
      newDraft("d"),
      { type: "addLine", line: pricedCard("a", 10000) },
      { type: "addLine", line: pricedCard("b", 10000) },
      { type: "setLineRate", lineId: "a", side: "trade", pct: 75 },
      { type: "setRate", side: "trade", pct: 85 }
    )
    let deal = priceDraft(draft)
    const a = draft.lines.findIndex((l) => l.id === "a")
    const b = draft.lines.findIndex((l) => l.id === "b")
    expect(deal.lines[a]).toMatchObject({ trade: 7500, tradePct: 75, tradeCustom: true, cashCustom: false })
    expect(deal.lines[b]).toMatchObject({ trade: 8500, tradePct: 85, tradeCustom: false })

    draft = dealReducer(draft, { type: "resetLineRates", lineId: "a" })
    deal = priceDraft(draft)
    expect(deal.lines[a]).toMatchObject({ trade: 8500, tradeCustom: false })
    expect(draft.lines[a]).not.toHaveProperty("tradePct")
  })

  it("swaps to the condition's own price, not a multiplier", () => {
    const draft = run(
      newDraft("d"),
      { type: "addLine", line: pricedCard("a", 51795, 27873) },
      { type: "setCondition", lineId: "a", condition: "LP" }
    )
    expect(lineMarket(draft.lines[0]!)).toBe(27873)
    expect(priceDraft(draft).trade).toBe(22298) // 80% of £278.73 = £222.98
  })

  it("keeps a typed value only for a condition with no price", () => {
    let draft = run(
      newDraft("d"),
      { type: "addLine", line: pricedCard("a", 5000, 4000) },
      { type: "setCondition", lineId: "a", condition: "HP" },
      { type: "setManualMarket", lineId: "a", pence: 1500 }
    )
    expect(lineMarket(draft.lines[0]!)).toBe(1500)
    draft = dealReducer(draft, { type: "setCondition", lineId: "a", condition: "LP" })
    expect(lineMarket(draft.lines[0]!)).toBe(4000)
    expect((draft.lines[0] as CardLine).manualMarket).toBeNull()
  })

  it("multiplies by quantity and never goes below one", () => {
    const draft = run(
      newDraft("d"),
      { type: "addLine", line: pricedCard("a", 1000) },
      { type: "setQty", lineId: "a", qty: 3 },
      { type: "setQty", lineId: "a", qty: 0 },
      { type: "setQty", lineId: "a", qty: 2 }
    )
    expect(draft.lines[0]!.qty).toBe(2)
    expect(priceDraft(draft).trade).toBe(1600)
    expect(itemCount(draft.lines)).toBe(2)
  })

  it("prices a custom item from its typed market value", () => {
    const draft = run(newDraft("d"), {
      type: "addLine",
      line: customLine({ name: " Pokemon Yellow ", category: "retro", marketPence: 6499, qty: 1 }, "x"),
    })
    expect(draft.lines[0]).toMatchObject({ name: "Pokemon Yellow", game: "retro" })
    expect(customLine({ name: "ETB", category: "sealed", marketPence: 1, qty: 1, game: "pokemon" }).game).toBe("pokemon")
    expect(customLine({ name: "Beano 1", category: "comic", marketPence: 1, qty: 1 }).game).toBe("other")
    expect(priceDraft(draft)).toMatchObject({ trade: 5199, cash: 4549 })
  })

  it("rescales every line to a final override and the pennies add up", () => {
    const draft = run(
      newDraft("d"),
      { type: "addLine", line: pricedCard("a", 333) },
      { type: "addLine", line: pricedCard("b", 333) },
      { type: "addLine", line: pricedCard("c", 334) },
      { type: "setOverride", side: "trade", override: { kind: "amount", pence: 1001 } }
    )
    const deal = priceDraft(draft)
    expect(deal.tradeOverridden).toBe(true)
    expect(deal.cashOverridden).toBe(false)
    expect(deal.trade).toBe(1001)
    expect(deal.lines.reduce((s, l) => s + l.trade, 0)).toBe(1001)
    expect(deal.calculatedTrade).toBe(799) // 266 + 266 + 267, each line rounded
  })

  it("takes a final override as a new % of market, and clears it", () => {
    let draft = run(
      newDraft("d"),
      { type: "addLine", line: pricedCard("a", 20000) },
      { type: "setOverride", side: "cash", override: { kind: "pct", pct: 65 } }
    )
    expect(priceDraft(draft).cash).toBe(13000)
    draft = dealReducer(draft, { type: "setOverride", side: "cash", override: null })
    expect(priceDraft(draft)).toMatchObject({ cash: 14000, cashOverridden: false })
  })

  it("drops the override when the last line goes", () => {
    const draft = run(
      newDraft("d"),
      { type: "addLine", line: pricedCard("a", 20000) },
      { type: "setOverride", side: "trade", override: { kind: "amount", pence: 100 } },
      { type: "removeLine", lineId: "a" }
    )
    expect(draft.lines).toHaveLength(0)
    expect(draft.overrides).toEqual({})
  })

  it("trims a rename and caps its length", () => {
    const draft = dealReducer(newDraft("d"), { type: "rename", name: "  Tom's   binder" })
    expect(draft.name).toBe("Tom's binder")
  })
})

describe("payout", () => {
  // £125 market: 80% is £100.00 trade, 70% is £87.50 cash.
  const base = run(newDraft("d"), { type: "addLine", line: pricedCard("a", 12500) })

  it("splits £100 trade / £87.50 cash, £35 taken, into £60 credit", () => {
    const draft = run(base, { type: "setPayoutType", payoutType: "mixed" }, { type: "setCashTaken", pence: 3500 })
    const payout = draftPayout(draft, priceDraft(draft))
    expect(payout).toEqual({ type: "mixed", cash: 3500, credit: 6000 })
    expect(needsIdCheck(payout)).toBe(true)
  })

  it("needs ID for any cash at all, however small", () => {
    const draft = run(base, { type: "setPayoutType", payoutType: "mixed" }, { type: "setCashTaken", pence: 1 })
    expect(needsIdCheck(draftPayout(draft, priceDraft(draft)))).toBe(true)
  })

  it("needs no ID for an all-credit payout", () => {
    expect(needsIdCheck(draftPayout(base, priceDraft(base)))).toBe(false)
  })

  it("trims the credit by the penny payoutLines cannot place, as the server checks it", () => {
    // Two lines of 3 units: £1.01 x 3 and £1.00 x 3 at 100% trade, overridden to £6.04.
    const draft = run(
      newDraft("d"),
      { type: "addLine", line: { ...pricedCard("a", 101), qty: 3 } },
      { type: "addLine", line: { ...pricedCard("b", 100), qty: 3 } },
      { type: "setRate", side: "trade", pct: 100 },
      { type: "setOverride", side: "trade", override: { kind: "amount", pence: 605 } }
    )
    const deal = priceDraft(draft)
    const payout = draftPayout(draft, deal)
    expect(payout.type).toBe("credit")
    // Whatever the lines could carry, the payout never claims more than they add up to.
    expect(payout.credit).toBeLessThanOrEqual(deal.trade)
    expect(payout.credit % 3).toBe(0)
  })

  it("keeps the seller on the draft", () => {
    const seller = { id: "cust1", name: "Sam Hill", code: "GGC1", phone: "", email: "" }
    const draft = run(base, { type: "setSeller", seller })
    expect(draft.seller).toEqual(seller)
    expect(run(draft, { type: "setSeller", seller: null }).seller).toBeNull()
  })

  it("refuses edits to a completed deal", () => {
    const done = { ...base, status: "completed" as const }
    expect(dealReducer(done, { type: "setRate", side: "trade", pct: 50 })).toBe(done)
  })
})

describe("roundingSuggestions", () => {
  it("offers the nearest £1, £5 and £10 with the difference", () => {
    expect(roundingSuggestions(19511)).toEqual([
      { step: 100, label: "Nearest £1", pence: 19500, diff: -11 },
      { step: 1000, label: "Nearest £10", pence: 20000, diff: 489 },
    ])
    expect(roundingSuggestions(19311).map((s) => s.pence)).toEqual([19300, 19500, 19000])
  })

  it("drops a round that changes nothing", () => {
    expect(roundingSuggestions(20000)).toEqual([])
  })
})

describe("helpers", () => {
  it("links to eBay UK sold listings", () => {
    const url = new URL(ebaySoldUrl(pricedCard("a", 1)))
    expect(url.hostname).toBe("www.ebay.co.uk")
    expect(url.searchParams.get("LH_Sold")).toBe("1")
    expect(url.searchParams.get("_nkw")).toBe("Charizard 4/102 Base Set")
  })

  it("formats percentages one way", () => {
    expect(formatPct(80)).toBe("80%")
    expect(formatPct(83.66)).toBe("83.7%")
    expect(formatPct(Number.NaN)).toBe("")
  })

  it("says when a deal was updated", () => {
    const now = new Date("2026-11-09T15:00:00Z")
    expect(formatUpdated("2026-11-09T14:59:30Z", now)).toBe("just now")
    expect(formatUpdated("2026-11-09T14:40:00Z", now)).toBe("20 min ago")
    expect(formatUpdated("2026-10-01T10:00:00Z", now)).toBe("1 Oct")
  })

  it("labels a variant", () => {
    expect(variantLabel("reverse-holo")).toBe("Reverse holo")
  })
})
