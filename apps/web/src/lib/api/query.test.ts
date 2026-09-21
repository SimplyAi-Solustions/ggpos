import { describe, expect, it } from "vitest"

import { parseCardQuery } from "@/lib/api/query"

describe("parseCardQuery", () => {
  it("treats a Pokemon name beside a number as a name search, not a set code", () => {
    expect(parseCardQuery("pikachu 25")).toEqual({ number: "25", text: "pikachu" })
  })

  it("still reads a real set code and number", () => {
    expect(parseCardQuery("sv151 199")).toEqual({ setCode: "sv151", number: "199" })
  })

  it("still reads a set code with a slash number", () => {
    expect(parseCardQuery("sv151 199/165")).toEqual({ setCode: "sv151", number: "199/165" })
  })

  it("does not mistake another short name for a set code", () => {
    expect(parseCardQuery("mew 151")).toEqual({ number: "151", text: "mew" })
  })

  it("treats a single word with no number as a plain name search", () => {
    expect(parseCardQuery("charizard")).toEqual({ text: "charizard" })
  })
})
