import { describe, expect, it } from "vitest"

import { autoMap, canImport, canonicalCsv, previewImport, readTable } from "./mapping"

const FILE = 'Title,Set Name,No.,Cond,Sale Price,Qty\r\n"Charizard ex, SIR",151,199,NM,349.99,1\r\nPikachu,151,25,LP,0.45,4\r\n\r\n'

describe("CSV import mapping", () => {
  it("maps the headers it knows and leaves the rest for staff", () => {
    const parsed = readTable(FILE)
    const map = autoMap(parsed.header)
    expect(map.name).toBe(0)
    expect(map.set).toBe(1)
    expect(map.price).toBe(4)
    expect(map.quantity).toBe(5)
    expect(map.number).toBe(-1)
    expect(map.condition).toBe(-1)
  })

  it("rewrites the file with the importer's header names", () => {
    const parsed = readTable(FILE)
    const map = { ...autoMap(parsed.header), number: 2, condition: 3 }
    expect(canonicalCsv(parsed, map)).toBe(
      'Card Name,Set,Number,Condition,Price,Quantity\r\n"Charizard ex, SIR",151,199,NM,349.99,1\r\nPikachu,151,25,LP,0.45,4\r\n'
    )
  })

  it("previews rows with no id as review rows", () => {
    const parsed = readTable(FILE)
    const p = previewImport(parsed, autoMap(parsed.header))
    expect(p.rows).toHaveLength(2)
    expect(p.review).toBe(2)
  })

  it("needs a name or an id", () => {
    expect(canImport({ name: -1, tcgplayerId: -1, cardmarketId: -1 })).not.toBeNull()
    expect(canImport({ name: 0 })).toBeNull()
  })
})
