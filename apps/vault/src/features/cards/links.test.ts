import { describe, expect, it } from "vitest"

import { cardmarketUrl, ebaySoldUrl, formatNative } from "./links"

const card = { name: "Umbreon VMAX", number: "215", set_name: "Evolving Skies", set_total: 203, game: "pokemon" }

describe("research links", () => {
  it("searches eBay UK sold and completed listings, newest first", () => {
    const url = new URL(ebaySoldUrl(card))
    expect(url.hostname).toBe("www.ebay.co.uk")
    expect(url.searchParams.get("_nkw")).toBe("Umbreon VMAX 215/203 Evolving Skies")
    expect(url.searchParams.get("LH_Sold")).toBe("1")
  })

  it("searches the right Cardmarket game", () => {
    expect(cardmarketUrl({ ...card, game: "onepiece" })).toContain("/en/OnePiece/Products/Search?searchString=Umbreon+VMAX")
  })

  it("formats a foreign amount for supporting detail", () => {
    expect(formatNative(1240, "EUR")).toBe("€12.40")
  })
})
