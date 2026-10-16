import { describe, expect, it } from "vitest"
import { roundToRetailEnding } from "@gg/shared"

import { pricingSettingsFrom } from "@/lib/api/prices"
import { suggestedSellPrice } from "@/features/pricing/suggest"

/** The seeded bands: 1.10 under £5, 1.05 to £50, 1.00 above. */
const seeded = pricingSettingsFrom(undefined)

describe("suggestedSellPrice", () => {
  it("marks a cheap card up by a tenth and lands on a retail ending", () => {
    // £2.00 * 1.10 = £2.20, which rounds up to £2.49.
    expect(suggestedSellPrice(200, seeded)).toBe(249)
  })

  it("marks the middle band up by a twentieth", () => {
    // £10.00 * 1.05 = £10.50, which rounds up to £10.99.
    expect(suggestedSellPrice(1000, seeded)).toBe(1099)
  })

  it("leaves the top band at market and still ends it properly", () => {
    // £316.79 * 1.00 = £316.79, which rounds up to £316.99.
    expect(suggestedSellPrice(31679, seeded)).toBe(31699)
  })

  it("uses the .49 ending when the pennies are under 50", () => {
    expect(roundToRetailEnding(31620)).toBe(31649)
    expect(suggestedSellPrice(30000, seeded)).toBe(30049)
  })

  it("takes the bands an admin has changed", () => {
    const settings = pricingSettingsFrom({
      markup_bands: [{ from: 0, multiplier: 1.5 }],
      sell_rounding: "49_99",
    })
    // £10.00 * 1.5 = £15.00, which rounds up to £15.49.
    expect(suggestedSellPrice(1000, settings)).toBe(1549)
  })

  it("leaves the figure alone when retail endings are switched off", () => {
    const settings = pricingSettingsFrom({
      markup_bands: [{ from: 0, multiplier: 1.1 }],
      sell_rounding: "none",
    })
    expect(suggestedSellPrice(1000, settings)).toBe(1100)
  })

  it("suggests nothing when there is no market value", () => {
    expect(suggestedSellPrice(null, seeded)).toBeNull()
    expect(suggestedSellPrice(undefined, seeded)).toBeNull()
    expect(suggestedSellPrice(0, seeded)).toBeNull()
  })
})

describe("pricingSettingsFrom", () => {
  it("falls back to the shared defaults, which are the seed's own figures", () => {
    expect(seeded.sourcePriority).toEqual([
      "uk_sold_manual",
      "ebay_uk_asking",
      "cardmarket",
      "tcgplayer",
    ])
    expect(seeded.retroSourcePriority).toEqual([
      "uk_sold_manual",
      "pricecharting_pal",
      "ebay_uk_asking",
      "pricecharting_ntsc",
    ])
    expect(seeded.conditionMultipliers.LP).toBe(0.85)
    expect(seeded.ebayHaircutPct).toBe(15)
  })

  it("takes the shop's own source order", () => {
    const settings = pricingSettingsFrom({
      source_priority: ["cardmarket", "uk_sold_manual"],
    })
    expect(settings.sourcePriority).toEqual(["cardmarket", "uk_sold_manual"])
  })

  it("ignores a source name it does not know", () => {
    const settings = pricingSettingsFrom({
      source_priority: ["cardmarket", "some_new_feed"],
    })
    expect(settings.sourcePriority).toEqual(["cardmarket"])
  })

  it("takes the haircut an admin has set", () => {
    const settings = pricingSettingsFrom({
      offer: { ebayHaircutPct: 20 } as Record<string, number>,
    })
    expect(settings.ebayHaircutPct).toBe(20)
  })
})
