import { describe, expect, it } from "vitest"
import { DEFAULT_RETRO_PRIORITY, DEFAULT_TCG_PRIORITY } from "@gg/shared"

import {
  addUkComp,
  getCard,
  getFx,
  getPrices,
  getRetroPrices,
  refreshPrices,
  searchCards,
  searchRetro,
} from "@/lib/api/demo/catalogue"

/**
 * The demo price book stands in for the routes, so it has to refuse and
 * choose the same way they do: these are the behaviours the e2e suite and
 * every screenshot rest on.
 */

describe("the demo lookup", () => {
  it("finds a card by set and number, and by name", () => {
    expect(searchCards("pokemon", "sv151 199")[0]?.name).toBe("Charizard ex")
    expect(searchCards("", "charizard")[0]?.name).toBe("Charizard ex")
    expect(getCard("pokemon", "sv151", "199")?.id).toBe("card_sv151_199")
  })

  it("covers every game in scope", () => {
    expect(searchCards("mtg", "mabel")).toHaveLength(1)
    expect(searchCards("yugioh", "dark magician")).toHaveLength(1)
    expect(searchCards("lorcana", "elsa")).toHaveLength(1)
    expect(searchCards("onepiece", "OP01-001")).toHaveLength(1)
  })

  it("refuses a One Piece name search in the route's own words", () => {
    expect(() => searchCards("onepiece", "zoro")).toThrow(
      "One Piece search needs a card code, for example OP01-001."
    )
    // Searching every game at once is not the One Piece adapter's problem.
    expect(() => searchCards("", "zoro")).not.toThrow()
  })

  it("finds a retro title, narrowed by platform", () => {
    expect(searchRetro("mario", "snes_pal_box")[0]?.name).toBe("Super Mario Kart")
    expect(searchRetro("mario", "n64_box")).toHaveLength(0)
  })
})

describe("the demo price book", () => {
  it("chooses the first fresh source in priority order", () => {
    const view = getPrices("card_sv151_199", "holo", DEFAULT_TCG_PRIORITY, 1)
    expect(view.chosen?.source).toBe("cardmarket")
    // eBay comes first in the order but its figure has gone stale.
    const ebay = view.sources.find((row) => row.source === "ebay_uk_asking")
    expect(ebay?.stale).toBe(true)
    expect(view.sources.map((row) => row.source)).toEqual([
      "ebay_uk_asking",
      "cardmarket",
      "tcgplayer",
    ])
  })

  it("keeps the native amount beside its conversion", () => {
    const view = getPrices("card_sv151_199", "holo", DEFAULT_TCG_PRIORITY, 1)
    expect(view.chosen?.native_currency).toBe("EUR")
    expect(view.chosen?.native_market).toBe(36830)
    // €368.30 at 0.8606.
    expect(view.chosen?.gbp_market).toBe(31696)
  })

  it("takes the condition off the chosen figure", () => {
    const view = getPrices("card_sv151_199", "holo", DEFAULT_TCG_PRIORITY, 0.85)
    expect(view.condition_adjusted).toBe(26942)
  })

  it("has a staff comp on the Yu-Gi-Oh card, with its listing", () => {
    const view = getPrices("card_ct13_en003", "holo", DEFAULT_TCG_PRIORITY, 1)
    expect(view.chosen?.source).toBe("uk_sold_manual")
    expect(view.chosen?.evidence_url).toContain("ebay.co.uk/itm/")
  })

  it("prices a retro title on the retro order", () => {
    const view = getRetroPrices("retro_smk", "cib", DEFAULT_RETRO_PRIORITY)
    expect(view.chosen?.source).toBe("pricecharting_pal")
    expect(view.condition_adjusted).toBeNull()
  })

  it("matches the finish exactly, as the route's own filter does", () => {
    // `card = {:card} && finish = {:finish}`: a holo row is not an answer to
    // a question about the normal printing, and a demo that matched loosely
    // would price cards the counter cannot.
    const holo = getPrices("card_sv151_199", "holo", DEFAULT_TCG_PRIORITY, 1)
    const normal = getPrices("card_sv151_199", "normal", DEFAULT_TCG_PRIORITY, 1)
    expect(holo.chosen?.gbp_market).not.toBe(normal.chosen?.gbp_market)
    // And a finish nobody has priced has nothing, rather than everything.
    expect(getPrices("card_sv151_199", "etched", DEFAULT_TCG_PRIORITY, 1).sources).toHaveLength(0)
  })

  it("answers nothing for a card it has never priced", () => {
    const view = getPrices("card_fdn_179", "foil", DEFAULT_TCG_PRIORITY, 1)
    expect(view.chosen).toBeNull()
    expect(view.sources).toHaveLength(0)
  })

  it("reports the rate's own ECB date, four days old", () => {
    const fx = getFx()
    expect(fx.stale).toBe(true)
    expect(fx.rates.EUR).toBe(0.8606)
    expect(fx.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe("what the write routes change", () => {
  it("makes a refreshed source the chosen one", () => {
    // Lorcana's only source is TCGplayer, so a refresh cannot change which
    // source wins; the One Piece card's stale Cardmarket row can.
    const before = getPrices("card_op01_001", "normal", DEFAULT_TCG_PRIORITY, 1)
    expect(before.sources.find((row) => row.source === "cardmarket")?.stale).toBe(true)

    refreshPrices("card_op01_001", "normal")

    const after = getPrices("card_op01_001", "normal", DEFAULT_TCG_PRIORITY, 1)
    expect(after.sources.find((row) => row.source === "cardmarket")?.stale).toBe(false)
    expect(after.chosen?.source).toBe("cardmarket")
  })

  it("files a retro comp under its completeness", () => {
    addUkComp("retro_gt", {
      completeness: "cib",
      price: 9000,
      url: "https://www.ebay.co.uk/itm/2",
      sold_at: new Date().toISOString().slice(0, 10),
    })

    expect(getRetroPrices("retro_gt", "cib", DEFAULT_RETRO_PRIORITY).chosen?.source).toBe(
      "uk_sold_manual"
    )
    // And nowhere else: a comp for the boxed copy is not one for the loose one.
    expect(getRetroPrices("retro_gt", "loose", DEFAULT_RETRO_PRIORITY).chosen).toBeNull()
  })

  it("puts a UK comp at the top", () => {
    addUkComp("card_tfc_042", {
      finish: "foil",
      price: 5000,
      url: "https://www.ebay.co.uk/itm/1",
      sold_at: new Date().toISOString().slice(0, 10),
    })

    const view = getPrices("card_tfc_042", "foil", DEFAULT_TCG_PRIORITY, 1)
    expect(view.chosen?.source).toBe("uk_sold_manual")
    expect(view.chosen?.gbp_market).toBe(5000)
    expect(view.chosen?.native_currency).toBe("GBP")
  })
})
