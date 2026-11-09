import { describe, expect, it } from "vitest"

import { modelLabel, searchTextFor, type CardRead } from "./api"

const read = { name_en: "Umbreon VMAX", name_printed: "Umbreon VMAX", collector_number: "215", set_total: "203" } as CardRead

describe("scan api helpers", () => {
  it("turns a read into a search", () => {
    expect(searchTextFor(read)).toBe("Umbreon VMAX 215/203")
    expect(searchTextFor({ ...read, collector_number: null })).toBe("Umbreon VMAX")
    expect(searchTextFor(null)).toBe("")
  })

  it("names the model", () => {
    expect(modelLabel("claude-sonnet-5-5")).toBe("Sonnet 5.5")
    expect(modelLabel("claude-haiku-5-5")).toBe("Haiku 5.5")
  })
})
