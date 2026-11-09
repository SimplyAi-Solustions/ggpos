import { describe, expect, it } from "vitest"

import type { Artist, ArtistCard } from "@/features/binders/api"
import { baseSpeciesName, buildIdeas, bulbapediaUrl } from "@/features/binders/artist"

function card(over: Partial<ArtistCard>): ArtistCard {
  return {
    card_id: "x-1",
    name: "Pikachu",
    number: "1",
    set_id: "base1",
    set_name: "Base Set",
    set_total: "102",
    serie: "base",
    serie_name: "Base",
    set_order: 1,
    image: "img",
    ...over,
  }
}

function artistOf(cards: ArtistCard[]): Artist {
  const sets: Artist["sets"] = []
  for (const c of cards) {
    const hit = sets.find((s) => s.id === c.set_id)
    if (hit) hit.count++
    else sets.push({ id: c.set_id, name: c.set_name, serie: c.serie, serie_name: c.serie_name, order: c.set_order, count: 1 })
  }
  return { name: "Test Artist", count: cards.length, cards, sets }
}

describe("baseSpeciesName", () => {
  it("strips battle suffixes, repeatedly", () => {
    expect(baseSpeciesName("Pikachu ex")).toBe("Pikachu")
    expect(baseSpeciesName("Charizard VMAX")).toBe("Charizard")
    expect(baseSpeciesName("Mewtwo LV. X")).toBe("Mewtwo")
    expect(baseSpeciesName("Snorlax")).toBe("Snorlax")
    expect(baseSpeciesName("Mr. Mime")).toBe("Mr. Mime")
  })
})

describe("buildIdeas", () => {
  it("suggests the most-drawn Pokémon across suffixes, a set and an era", () => {
    const cards: ArtistCard[] = []
    // 6 Gyarados in two eras, plus filler in a modern set
    for (let i = 0; i < 3; i++) cards.push(card({ card_id: `base1-${i}`, name: i ? "Gyarados" : "Gyarados ex" }))
    for (let i = 0; i < 3; i++)
      cards.push(card({ card_id: `sv1-${i}`, name: "Gyarados VMAX", set_id: "sv1", set_name: "Scarlet & Violet", serie: "sv", serie_name: "Scarlet & Violet", set_order: 80 }))
    for (let i = 0; i < 6; i++)
      cards.push(card({ card_id: `sv2-${i}`, name: `Other ${i}`, set_id: "sv2", set_name: "Paldea Evolved", serie: "sv", serie_name: "Scarlet & Violet", set_order: 81 }))

    const ideas = buildIdeas(artistOf(cards))
    const keys = ideas.map((i) => i.key)
    expect(keys).toContain("species")
    const species = ideas.find((i) => i.key === "species")!
    expect(species.title).toBe("Gyarados by Test Artist")
    expect(species.cards).toHaveLength(6)

    expect(keys).toContain("set")
    expect(ideas.find((i) => i.key === "set")!.cards).toHaveLength(6)

    expect(keys).toContain("era")
    const era = ideas.find((i) => i.key === "era")!
    expect(era.cards).toHaveLength(9)
    expect(era.title).toContain("Scarlet & Violet")
  })

  it("drops ideas that are tiny or just the whole collection again", () => {
    // 3 cards of one Pokémon in one set: every grouping is either under the
    // minimum or the full collection, so there is nothing worth suggesting.
    const ideas = buildIdeas(artistOf([0, 1, 2].map((i) => card({ card_id: `base1-${i}` }))))
    expect(ideas).toHaveLength(0)
  })

  it("never suggests more than four", () => {
    const cards: ArtistCard[] = []
    for (let s = 0; s < 5; s++)
      for (let i = 0; i < 6; i++)
        cards.push(
          card({
            card_id: `s${s}-${i}`,
            name: `Mon${s}`,
            set_id: `s${s}`,
            set_name: `Set ${s}`,
            serie: `serie${s}`,
            serie_name: `Serie ${s}`,
            set_order: s + 1,
          })
        )
    expect(buildIdeas(artistOf(cards)).length).toBeLessThanOrEqual(4)
  })
})

describe("bulbapediaUrl", () => {
  it("links the artist's wiki page, spaces as underscores", () => {
    expect(bulbapediaUrl("Mitsuhiro Arita")).toBe("https://bulbapedia.bulbagarden.net/wiki/Mitsuhiro_Arita")
  })
})
