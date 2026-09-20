import { describe, expect, it } from "vitest"
import { DEFAULT_RETRO_PRIORITY, DEFAULT_TCG_PRIORITY } from "@gg/shared"

import {
  ageLabel,
  formatNative,
  formatRate,
  fxWarning,
  marketLine,
  shortDate,
  sourceDetail,
  sourceLabel,
  sourceRows,
} from "@/features/pricing/sources"
import type { PriceSourceRow, PriceView } from "@/lib/api/types"

const NOW = new Date("2026-09-20T12:00:00.000Z")

function row(over: Partial<PriceSourceRow> = {}): PriceSourceRow {
  return {
    source: "cardmarket",
    gbp_market: 31699,
    native_currency: "EUR",
    native_market: 36830,
    fx_rate: 0.8606,
    fx_date: "2026-09-20T00:00:00.000Z",
    fetched_at: "2026-09-20T08:00:00.000Z",
    stale: false,
    evidence_url: "",
    ...over,
  }
}

describe("sourceLabel", () => {
  it("names each source the way the contract does", () => {
    expect(sourceLabel("uk_sold_manual")).toBe("UK sold comp")
    expect(sourceLabel("ebay_uk_asking")).toBe("eBay UK asking")
    expect(sourceLabel("cardmarket")).toBe("Cardmarket")
    expect(sourceLabel("tcgplayer")).toBe("TCGplayer")
    expect(sourceLabel("pricecharting_pal")).toBe("PriceCharting PAL")
    expect(sourceLabel("pricecharting_ntsc")).toBe("PriceCharting NTSC")
  })

  it("credits OPTCG for a One Piece price stored under tcgplayer", () => {
    expect(sourceLabel("tcgplayer", "onepiece")).toBe("TCGplayer (OPTCG)")
    expect(sourceLabel("cardmarket", "onepiece")).toBe("Cardmarket")
  })
})

describe("formatting", () => {
  it("formats a foreign amount with its own symbol and our grouping", () => {
    expect(formatNative(36830, "EUR")).toBe("€368.30")
    expect(formatNative(123456, "USD")).toBe("$1,234.56")
    expect(formatNative(45, "GBP")).toBe("£0.45")
  })

  it("trims a rate to what it actually says", () => {
    expect(formatRate(0.8606)).toBe("0.8606")
    expect(formatRate(0.75)).toBe("0.75")
    expect(formatRate(null)).toBe("")
  })

  it("writes a date the way a counter says it", () => {
    expect(shortDate("2026-09-12T00:00:00.000Z")).toBe("12 Sep")
    expect(shortDate("")).toBe("")
    expect(shortDate("not a date")).toBe("")
  })

  it("says how old a figure is in words", () => {
    expect(ageLabel("2026-09-20T11:40:00.000Z", NOW)).toBe("just now")
    expect(ageLabel("2026-09-20T11:00:00.000Z", NOW)).toBe("1 hour ago")
    expect(ageLabel("2026-09-20T08:00:00.000Z", NOW)).toBe("4 hours ago")
    expect(ageLabel("2026-09-18T12:00:00.000Z", NOW)).toBe("2 days ago")
  })
})

describe("sourceDetail", () => {
  it("puts a converted figure beside its native amount, rate and date", () => {
    expect(sourceDetail(row())).toBe("from Cardmarket €368.30 at 0.8606, 20 Sep")
  })

  it("credits OPTCG on a One Piece row", () => {
    expect(
      sourceDetail(row({ source: "tcgplayer", native_currency: "USD", native_market: 1899 }), {
        gameKey: "onepiece",
      })
    ).toBe("from TCGplayer (OPTCG) $18.99 at 0.8606, 20 Sep")
  })

  it("says the haircut has already come off an eBay asking price", () => {
    expect(
      sourceDetail(row({ source: "ebay_uk_asking", native_currency: "GBP" }), {
        haircutPct: 15,
      })
    ).toBe("eBay UK asking, after the 15% haircut")
  })

  it("dates a UK sold comp from the sale, not from the fetch", () => {
    expect(
      sourceDetail(
        row({
          source: "uk_sold_manual",
          native_currency: "GBP",
          fetched_at: "2026-09-12T00:00:00.000Z",
        })
      )
    ).toBe("UK sold comp, ebay.co.uk, 12 Sep")
  })

  it("never writes a foreign amount without the conversion beside it", () => {
    const detail = sourceDetail(row())
    expect(detail).toContain("€368.30")
    // The GBP figure sits in the row's own column; the detail only ever
    // explains where the conversion came from.
    expect(detail.startsWith("from")).toBe(true)
  })
})

describe("sourceRows", () => {
  const view: PriceView = {
    chosen: row(),
    sources: [
      row({ source: "ebay_uk_asking", native_currency: "GBP", gbp_market: 33915, stale: true }),
      row(),
      row({ source: "tcgplayer", native_currency: "USD", native_market: 42100, gbp_market: 31575 }),
    ],
    condition_adjusted: 26944,
  }

  it("keeps the shop's whole priority order, missing sources included", () => {
    const rows = sourceRows(view, DEFAULT_TCG_PRIORITY)
    expect(rows.map((entry) => entry.source)).toEqual([
      "uk_sold_manual",
      "ebay_uk_asking",
      "cardmarket",
      "tcgplayer",
    ])
    expect(rows[0]?.gbp).toBeNull()
    expect(rows[0]?.detail).toBe("")
  })

  it("marks the chosen row, and only that one", () => {
    const rows = sourceRows(view, DEFAULT_TCG_PRIORITY)
    expect(rows.filter((entry) => entry.chosen).map((entry) => entry.source)).toEqual([
      "cardmarket",
    ])
  })

  it("flags a stale row rather than hiding it", () => {
    const rows = sourceRows(view, DEFAULT_TCG_PRIORITY)
    const ebay = rows.find((entry) => entry.source === "ebay_uk_asking")
    expect(ebay?.stale).toBe(true)
    expect(ebay?.gbp).toBe(33915)
  })

  it("carries a comp's evidence link", () => {
    const rows = sourceRows(
      {
        chosen: row({
          source: "uk_sold_manual",
          native_currency: "GBP",
          evidence_url: "https://www.ebay.co.uk/itm/1",
        }),
        sources: [
          row({
            source: "uk_sold_manual",
            native_currency: "GBP",
            evidence_url: "https://www.ebay.co.uk/itm/1",
          }),
        ],
        condition_adjusted: null,
      },
      DEFAULT_TCG_PRIORITY
    )
    expect(rows[0]?.evidenceUrl).toBe("https://www.ebay.co.uk/itm/1")
  })

  it("keeps a source the priority list has never heard of on the end", () => {
    const rows = sourceRows(
      {
        chosen: null,
        sources: [row({ source: "pricecharting_pal" })],
        condition_adjusted: null,
      },
      DEFAULT_TCG_PRIORITY
    )
    expect(rows[rows.length - 1]?.source).toBe("pricecharting_pal")
  })

  it("orders a retro title by the retro priority", () => {
    const rows = sourceRows(undefined, DEFAULT_RETRO_PRIORITY)
    expect(rows.map((entry) => entry.source)).toEqual([
      "uk_sold_manual",
      "pricecharting_pal",
      "ebay_uk_asking",
      "pricecharting_ntsc",
    ])
    expect(rows.every((entry) => entry.gbp === null)).toBe(true)
  })
})

describe("marketLine", () => {
  it("names the source and how old it is", () => {
    expect(
      marketLine({ chosen: row(), sources: [row()], condition_adjusted: null }, { now: NOW })
    ).toBe("Cardmarket, 4 hours ago")
  })

  it("says what to do about a stale figure", () => {
    const stale = row({ stale: true, fetched_at: "2026-09-18T12:00:00.000Z" })
    expect(
      marketLine({ chosen: stale, sources: [stale], condition_adjusted: null }, { now: NOW })
    ).toBe("Cardmarket, 2 days ago. Refresh for a newer figure.")
  })

  it("says what to do when nothing has a value", () => {
    expect(marketLine({ chosen: null, sources: [], condition_adjusted: null })).toBe(
      "No price yet. Refresh or enter it."
    )
  })

  it("says so when the figure was typed by hand", () => {
    expect(marketLine(undefined, { manual: true })).toBe("Entered by hand")
  })
})

describe("fxWarning", () => {
  it("counts the days and never blocks anything", () => {
    expect(fxWarning("2026-09-16T12:00:00.000Z", NOW)).toBe(
      "FX rate is 4 days old. Converted prices may be off."
    )
    expect(fxWarning("2026-09-19T12:00:00.000Z", NOW)).toBe(
      "FX rate is 1 day old. Converted prices may be off."
    )
  })

  it("says plainly when there is no rate at all", () => {
    expect(fxWarning(null, NOW)).toBe(
      "No FX rate yet, so no converted price can be shown."
    )
  })
})
