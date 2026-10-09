import {
  compRange,
  ebaySoldUrl,
  hermesConfig,
  researchStatusWords,
  researchWords,
} from "../src/agents"

describe("researchWords", () => {
  it("names a card by its name, set and number, and leaves a normal printing's finish out", () => {
    expect(researchWords({ name: "Charizard ex", setName: "151", number: "199", finish: "normal", condition: "NM", kind: "card" })).toBe(
      "Charizard ex 151 199"
    )
  })

  it("adds the finish words a seller puts in a title", () => {
    expect(researchWords({ name: "Pikachu", setName: "Base Set", number: "58", finish: "reverse", kind: "card" })).toBe(
      "Pikachu Base Set 58 reverse holo"
    )
    expect(researchWords({ name: "Charizard", setName: "Base Set", number: "4", finish: "first_edition", kind: "card" })).toBe(
      "Charizard Base Set 4 1st edition"
    )
  })

  it("never says a raw card's condition, because sold listings rarely do", () => {
    expect(researchWords({ name: "Mew", number: "151", condition: "LP", kind: "card" })).toBe("Mew 151")
  })

  it("says a graded card's grade", () => {
    expect(researchWords({ name: "Umbreon VMAX", setName: "Evolving Skies", number: "215", kind: "graded", grade: "PSA 10" })).toBe(
      "Umbreon VMAX Evolving Skies 215 PSA 10"
    )
  })

  it("says boxed or complete for retro, and nothing for loose", () => {
    expect(researchWords({ name: "Super Mario World", finish: "boxed", kind: "retro" })).toBe("Super Mario World boxed")
    expect(researchWords({ name: "Super Mario World", finish: "cib", kind: "retro" })).toBe("Super Mario World complete")
    expect(researchWords({ name: "Super Mario World", finish: "loose", kind: "retro" })).toBe("Super Mario World")
  })

  it("does not repeat a set or a number the name already carries", () => {
    expect(researchWords({ name: "Pokemon 151 Elite Trainer Box", setName: "151", kind: "sealed" })).toBe(
      "Pokemon 151 Elite Trainer Box"
    )
  })
})

describe("ebaySoldUrl", () => {
  it("opens ebay.co.uk's sold and completed listings from UK sellers", () => {
    const url = new URL(ebaySoldUrl("Charizard ex 151 199"))
    expect(url.origin).toBe("https://www.ebay.co.uk")
    expect(url.pathname).toBe("/sch/i.html")
    expect(url.searchParams.get("_nkw")).toBe("Charizard ex 151 199")
    expect(url.searchParams.get("LH_Sold")).toBe("1")
    expect(url.searchParams.get("LH_Complete")).toBe("1")
    expect(url.searchParams.get("LH_PrefLoc")).toBe("1")
  })

  it("escapes what would break the query", () => {
    const url = new URL(ebaySoldUrl("Pokémon & friends #1/100"))
    expect(url.searchParams.get("_nkw")).toBe("Pokémon & friends #1/100")
  })
})

describe("researchStatusWords", () => {
  const agent = { id: "a1", name: "Gandalf", kind: "agent" as const }
  it("says where a request has got to in words", () => {
    expect(researchStatusWords({ status: "open", claimed_by: null, comps: [] })).toBe("Waiting for an agent")
    expect(researchStatusWords({ status: "claimed", claimed_by: agent, comps: [] })).toBe("Gandalf is looking")
    expect(researchStatusWords({ status: "cancelled", claimed_by: null, comps: [] })).toBe("Cancelled")
    expect(researchStatusWords({ status: "done", claimed_by: agent, comps: [] })).toBe("Gandalf found nothing sold")
    const comp = { price: 4500, currency: "GBP", sold_at: "2026-10-01", url: "https://www.ebay.co.uk/itm/1", title: "", condition: "" }
    expect(researchStatusWords({ status: "done", claimed_by: agent, comps: [comp, comp] })).toBe("Gandalf found 2 sold")
  })
})

describe("compRange", () => {
  it("is the lowest and highest price, or null with none", () => {
    expect(compRange([])).toBeNull()
    expect(compRange([{ price: 4800 }, { price: 4500 }, { price: 5200 }])).toEqual({ low: 4500, high: 5200 })
  })
})

describe("hermesConfig", () => {
  it("gives the mcp_servers block both ways, with the token where Hermes reads it", () => {
    const config = hermesConfig({ baseUrl: "https://ggpos.ggentertainment.co.uk/", token: "tok.en.value" })
    expect(config.http).toContain("mcp_servers:")
    expect(config.http).toContain('url: "https://ggpos.ggentertainment.co.uk/api/vault/mcp"')
    expect(config.http).toContain('Authorization: "Bearer tok.en.value"')
    expect(config.stdio).toContain('command: "node"')
    expect(config.stdio).toContain('GGVAULT_URL: "https://ggpos.ggentertainment.co.uk"')
    expect(config.stdio).toContain('GGVAULT_TOKEN: "tok.en.value"')
    expect(config.stdio).toContain("services/mcp/stdio.mjs")
  })
})
