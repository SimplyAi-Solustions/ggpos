import { describe, expect, it } from "vitest"
import {
  DEFAULT_RETRO_PRIORITY,
  DEFAULT_TCG_PRIORITY,
  adjustForCondition,
  chooseMarketPrice,
  computeOffer,
  selectRule,
  suggestSellPrice,
  type PriceCandidate,
  type PricingRule,
} from "../src/pricing"
import { roundToRetailEnding } from "../src/money"

const now = new Date("2026-09-19T12:00:00Z")
const hoursAgo = (h: number) => new Date(now.getTime() - h * 36e5).toISOString()

function cand(source: PriceCandidate["source"], gbp: number, ageHours: number): PriceCandidate {
  return {
    source,
    gbpMarket: gbp,
    fetchedAt: hoursAgo(ageHours),
    nativeCurrency: source === "cardmarket" ? "EUR" : source.startsWith("pricecharting") || source === "tcgplayer" ? "USD" : "GBP",
    nativeAmount: gbp,
    fxRate: null,
    fxDate: null,
  }
}

describe("chooseMarketPrice: UK first", () => {
  it("prefers a fresh UK sold comp over everything", () => {
    const r = chooseMarketPrice(
      [cand("cardmarket", 1400, 2), cand("uk_sold_manual", 1500, 24 * 10), cand("ebay_uk_asking", 1600, 3)],
      DEFAULT_TCG_PRIORITY,
      now
    )
    expect(r.chosen?.source).toBe("uk_sold_manual")
    expect(r.considered.map((c) => c.status)).toEqual(["chosen", "skipped", "skipped"])
  })
  it("skips a stale UK comp and takes eBay UK, then Cardmarket, then TCGplayer", () => {
    const r = chooseMarketPrice(
      [cand("uk_sold_manual", 1500, 24 * 40), cand("cardmarket", 1400, 2), cand("tcgplayer", 1300, 2)],
      DEFAULT_TCG_PRIORITY,
      now
    )
    expect(r.chosen?.source).toBe("cardmarket")
    expect(r.considered[0]?.status).toBe("stale")
  })
  it("falls back to the freshest stale value when nothing is fresh", () => {
    const r = chooseMarketPrice([cand("tcgplayer", 1300, 100), cand("cardmarket", 1400, 90)], DEFAULT_TCG_PRIORITY, now)
    expect(r.chosen?.source).toBe("cardmarket")
  })
  it("uses PAL PriceCharting before NTSC for retro", () => {
    const r = chooseMarketPrice(
      [cand("pricecharting_ntsc", 2000, 5), cand("pricecharting_pal", 2600, 5)],
      DEFAULT_RETRO_PRIORITY,
      now
    )
    expect(r.chosen?.source).toBe("pricecharting_pal")
  })
  it("returns null with no candidates", () => {
    expect(chooseMarketPrice([], DEFAULT_TCG_PRIORITY, now).chosen).toBeNull()
  })
})

describe("condition", () => {
  it("applies multipliers half-up", () => {
    expect(adjustForCondition(1000, "NM")).toBe(1000)
    expect(adjustForCondition(1001, "LP")).toBe(851)
    expect(adjustForCondition(999, "DMG")).toBe(300)
  })
})

const rules: PricingRule[] = [
  { id: "any", game: null, kind: "single", condition: null, finish: null, rarity: null, bandMin: 0, bandMax: null, cashPct: 40, creditPct: 55, rounding: 25, priority: 0, active: true },
  { id: "pk-mid", game: "pokemon", kind: "single", condition: null, finish: null, rarity: null, bandMin: 500, bandMax: 5000, cashPct: 50, creditPct: 65, rounding: 50, priority: 0, active: true },
  { id: "pk-high", game: "pokemon", kind: "single", condition: null, finish: null, rarity: null, bandMin: 5000, bandMax: null, cashPct: 60, creditPct: 75, rounding: 100, priority: 0, active: true },
  { id: "pk-nm-mid", game: "pokemon", kind: "single", condition: "NM", finish: null, rarity: null, bandMin: 500, bandMax: 5000, cashPct: 55, creditPct: 70, rounding: 50, priority: 0, active: true },
  { id: "off", game: "pokemon", kind: "single", condition: null, finish: null, rarity: null, bandMin: 0, bandMax: null, cashPct: 99, creditPct: 99, rounding: 25, priority: 9, active: false },
]

describe("selectRule", () => {
  it("picks the most specific active rule for the band", () => {
    expect(selectRule(rules, { game: "pokemon", kind: "single", condition: "NM" }, 2000)?.id).toBe("pk-nm-mid")
    expect(selectRule(rules, { game: "pokemon", kind: "single", condition: "LP" }, 2000)?.id).toBe("pk-mid")
    expect(selectRule(rules, { game: "pokemon", kind: "single", condition: "LP" }, 9000)?.id).toBe("pk-high")
    expect(selectRule(rules, { game: "mtg", kind: "single", condition: "NM" }, 2000)?.id).toBe("any")
  })
  it("ignores inactive rules and returns null when nothing matches", () => {
    expect(selectRule(rules, { game: "pokemon", kind: "retro", condition: "loose" }, 2000)).toBeNull()
  })
})

describe("computeOffer", () => {
  it("computes cash and credit with rounding steps", () => {
    // £20 NM Pokémon: pk-nm-mid 55 / 70, rounding 50p -> £11.00 / £14.00
    const o = computeOffer(2000, { game: "pokemon", kind: "single", condition: "NM" }, rules)
    expect(o.cash).toBe(1100)
    expect(o.credit).toBe(1400)
    expect(o.rule?.id).toBe("pk-nm-mid")
    expect(o.bulk).toBe(false)
  })
  it("adjusts for condition before choosing the band", () => {
    // £60 LP -> £51 adjusted -> pk-high 60 / 75, rounding £1 -> £31 / £38
    const o = computeOffer(6000, { game: "pokemon", kind: "single", condition: "LP" }, rules)
    expect(o.adjustedMarket).toBe(5100)
    expect(o.rule?.id).toBe("pk-high")
    expect(o.cash).toBe(3100)
    expect(o.credit).toBe(3800)
  })
  it("uses the bulk rate for pennies and never goes below the minimum", () => {
    const bulk = computeOffer(80, { game: "pokemon", kind: "single", condition: "NM" }, rules)
    expect(bulk.bulk).toBe(true)
    expect(bulk.cash).toBe(5)
    const low = computeOffer(150, { game: "mtg", kind: "single", condition: "NM" }, rules)
    expect(low.cash).toBe(50) // 40% of 150 = 60 -> step 25 -> 50, above minimum 25
  })
})

describe("suggestSellPrice", () => {
  it("applies markup bands and retail endings", () => {
    expect(suggestSellPrice(400, undefined, roundToRetailEnding)).toBe(449) // 400 * 1.1 = 440 -> .49
    expect(suggestSellPrice(2000, undefined, roundToRetailEnding)).toBe(2149) // 2000 * 1.05 = 2100 -> 2149
    expect(suggestSellPrice(8000, undefined, roundToRetailEnding)).toBe(8049)
  })
})
