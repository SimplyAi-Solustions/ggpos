import { describe, expect, it } from "vitest"
import {
  CROCKFORD_ALPHABET,
  buildCode,
  computeCheckChar,
  displayCode,
  encodeCode,
  generateCode,
  isValidCode,
  normaliseCode,
  parseCode,
} from "../src/sku"

describe("alphabet", () => {
  it("has 32 symbols and no I, L, O or U", () => {
    expect(CROCKFORD_ALPHABET).toHaveLength(32)
    for (const bad of ["I", "L", "O", "U"]) {
      expect(CROCKFORD_ALPHABET.includes(bad)).toBe(false)
    }
  })
})

describe("buildCode and parseCode", () => {
  it("round-trips display and encoded forms", () => {
    const code = buildCode("single", "7F3K2")
    expect(code.display).toMatch(/^GGS-7F3K2[0-9A-Z]$/)
    expect(code.encoded).toBe(code.display.replace("-", ""))
    expect(parseCode(code.display)).toEqual(code)
    expect(parseCode(code.encoded)).toEqual(code)
    expect(parseCode(code.display.toLowerCase())).toEqual(code)
  })
  it("routes by kind letter", () => {
    expect(buildCode("customer", "AB12C").kind).toBe("customer")
    expect(buildCode("voucher", "AB12C").kind).toBe("voucher")
    expect(buildCode("retro", "AB12C").letter).toBe("R")
  })
  it("rejects a wrong check character, wrong length, wrong prefix and bad kind", () => {
    const code = buildCode("sealed", "Q9Z8Y")
    const wrongCheck =
      code.encoded.slice(0, -1) +
      CROCKFORD_ALPHABET[(CROCKFORD_ALPHABET.indexOf(code.check) + 1) % 32]
    expect(parseCode(wrongCheck)).toBeNull()
    expect(parseCode(code.encoded + "A")).toBeNull()
    expect(parseCode("XX" + code.encoded.slice(2))).toBeNull()
    expect(parseCode("GGI" + code.encoded.slice(3))).toBeNull()
    expect(isValidCode("")).toBe(false)
  })
  it("catches adjacent transpositions in the body", () => {
    const code = buildCode("single", "7F3K2")
    const swapped = code.encoded.slice(0, 3) + "F73K2" + code.check
    expect(parseCode(swapped)).toBeNull()
  })
})

describe("normaliseCode", () => {
  it("uppercases, strips hyphens and spaces, and maps I, L and O", () => {
    expect(normaliseCode(" ggs-7f3k2q ")).toBe("GGS7F3K2Q")
    expect(normaliseCode("GGS-7F3KIO")).toBe("GGS7F3K10")
    expect(normaliseCode("GGS-7F3KLO")).toBe("GGS7F3K10")
  })
})

describe("generateCode", () => {
  it("produces valid codes of the requested kind with a deterministic source", () => {
    let n = 0
    const code = generateCode("graded", () => (n += 7) & 255)
    expect(code.kind).toBe("graded")
    expect(isValidCode(code.encoded)).toBe(true)
    expect(computeCheckChar(code.letter, code.body)).toBe(code.check)
  })
  it("produces valid codes with the default random source", () => {
    for (let i = 0; i < 50; i++) {
      expect(isValidCode(generateCode("single").encoded)).toBe(true)
    }
  })
})

describe("display and encode helpers", () => {
  it("formats valid codes and leaves invalid input alone", () => {
    const code = buildCode("accessory", "12345")
    expect(displayCode(code.encoded)).toBe(code.display)
    expect(encodeCode(code.display)).toBe(code.encoded)
    expect(displayCode("nonsense")).toBe("nonsense")
  })
})
