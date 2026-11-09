/**
 * The server's pure scan helpers (pb/pb_hooks/lib/vault_scan.js): reading
 * the model's reply, ranking our catalogue against a read, the auto-accept
 * rule, and the typo-tolerant search scoring behind /cards.
 */
import { describe, expect, it } from "vitest"

import * as scan from "../../../../../pb/pb_hooks/lib/vault_scan.js"

const umbreonAlt = { id: "a", name: "Umbreon VMAX", number: "215", set_code: "swsh7", set_name: "Evolving Skies", set_total: 203, release_date: "2021-08-27", language: "en" }
const umbreonRainbow = { ...umbreonAlt, id: "b", number: "214" }
const umbreonRegular = { ...umbreonAlt, id: "c", number: "095" }
const umbreonJP = { id: "d", name: "Umbreon VMAX", number: "095", set_code: "s6a", set_name: "Eevee Heroes", set_total: 69, release_date: "2021-05-28", language: "ja" }

function read(over: Partial<scan.ScanRead> = {}): scan.ScanRead {
  return scan.cleanRead({
    game: "pokemon",
    name_printed: "Umbreon VMAX",
    name_en: "Umbreon VMAX",
    set_code: null,
    collector_number: "215",
    set_total: "203",
    language: "en",
    confidence: { name_printed: 0.95, name_en: 0.95, collector_number: 0.95, set_total: 0.9, language: 1 },
    ...over,
  })
}

describe("parseModelJson", () => {
  it("reads a fenced reply and one with prose around it", () => {
    expect(scan.parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(scan.parseModelJson('Here it is: {"a":2} done')).toEqual({ a: 2 })
    expect(scan.parseModelJson("no json")).toBeNull()
  })
})

describe("identify ranking", () => {
  it("auto-accepts only when name, number and set all agree with daylight to the next card", () => {
    const ranked = scan.rankForRead(read(), [umbreonRegular, umbreonRainbow, umbreonAlt])
    expect(ranked[0]!.card.id).toBe("a")
    expect(scan.agreement(read(), ranked)).toEqual({ accept: true, reasons: [] })
  })

  it("never auto-accepts without a collector number, and asks Sonnet to look", () => {
    const r = read({ collector_number: null, confidence: { name_en: 0.95, name_printed: 0.95, collector_number: 0 } })
    expect(scan.needsDeepDive(r)).toBe(true)
    const verdict = scan.agreement(r, scan.rankForRead(r, [umbreonAlt, umbreonRainbow]))
    expect(verdict.accept).toBe(false)
    expect(verdict.reasons).toContain("Collector number not read")
  })

  it("flags a Japanese read matched to an English card instead of accepting it", () => {
    const r = read({ collector_number: "095", set_total: "069", language: "ja" })
    const ranked = scan.rankForRead(r, [umbreonRegular])
    const verdict = scan.agreement(r, ranked)
    expect(verdict.accept).toBe(false)
    expect(verdict.reasons).toContain("Japanese print, confirm")
    // With the JP card in the catalogue it ranks first and the language agrees.
    const withJp = scan.rankForRead(r, [umbreonRegular, umbreonJP])
    expect(withJp[0]!.card.id).toBe("d")
  })
})

describe("search scoring", () => {
  const score = (q: string, card: scan.ScoreCard) => scan.searchScore(scan.parseQuery(q), card)

  it("finds a card by number and set total alone", () => {
    expect(scan.parseQuery("215/203")).toMatchObject({ number: "215", total: "203", words: [] })
    expect(score("215/203", umbreonAlt)).toBeGreaterThan(0)
    expect(score("215/203", umbreonRainbow)).toBe(0)
  })

  it("tolerates a typo in the name", () => {
    expect(score("umbrion vmax", umbreonAlt)).toBeGreaterThan(0)
    expect(score("umbreon vmax", umbreonAlt)).toBeGreaterThan(score("umbrion vmax", umbreonAlt))
    expect(scan.likeTerms(scan.parseQuery("umbrion vmax"))).toEqual(["umb", "vmax"])
  })

  it("reads a set code and number, Japanese style", () => {
    expect(score("s6a 095", umbreonJP)).toBeGreaterThan(score("s6a 095", umbreonRegular))
  })

  it("reads a One Piece card code", () => {
    const op = { name: "Monkey.D.Luffy", number: "OP05-119", set_code: "OP05", set_name: "Awakening of the New Era" }
    expect(scan.parseQuery("OP05-119").code).toBe("OP05-119")
    expect(score("OP05-119", op)).toBeGreaterThan(0)
  })

  it("does not match a name that is not there", () => {
    expect(score("charizard", umbreonAlt)).toBe(0)
  })
})

describe("variantTag", () => {
  it("names the look-alikes apart", () => {
    expect(scan.variantTag({ name: "Charizard", set_name: "Base Set Shadowless", rarity: "Rare Holo" })).toBe("Shadowless")
    expect(scan.variantTag({ name: "Umbreon VMAX", rarity: "Secret Rare" })).toBe("Secret Rare")
    expect(scan.variantTag({ name: "Pikachu", rarity: "Rare Holo" })).toBe("Holo")
  })
})
