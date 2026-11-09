/// <reference types="node" />
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"

import { beforeAll, describe, expect, it } from "vitest"
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader"

import { buildCode } from "@gg/shared"

import { code128Modules, code128Values, eposBarcode, PATTERNS, QUIET_ZONE } from "./code128"
import type { BarcodeOp, Measure, TextOp } from "./draw"
import { BARCODE_HEIGHT, PAD_Y, priceLabelLayout, priceLabelSize, PRICE_LABEL_SIZES } from "./layout"
import { barcodeRects } from "./paint"

const measure: Measure = (text, font) => Array.from(text).length * font.size * (font.family === "Anton" ? 0.45 : 0.5)

/** The label as the printer gets it, one byte a dot: the painter's own bar rectangles, nothing else. */
function rasterBars(op: BarcodeOp, width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  for (const rect of barcodeRects(op)) {
    for (let y = op.y; y < op.y + op.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        const i = (y * width + x) * 4
        data[i] = 0
        data[i + 1] = 0
        data[i + 2] = 0
      }
    }
  }
  return { data, width, height, colorSpace: "srgb" } as ImageData
}

beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const wasm = readFileSync(require.resolve("zxing-wasm/reader/zxing_reader.wasm"))
  // Offline: hand the reader its own wasm rather than letting it fetch one.
  await prepareZXingModule({
    overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) },
    fireImmediately: true,
  })
})

describe("Code 128", () => {
  it("has the 107 standard patterns, 11 modules each and 13 for Stop", () => {
    expect(PATTERNS).toHaveLength(107)
    expect(new Set(PATTERNS).size).toBe(107)
    PATTERNS.forEach((p, i) => {
      expect([...p].reduce((a, c) => a + Number(c), 0)).toBe(i === 106 ? 13 : 11)
    })
  })

  it("adds the mod 103 check after Start B", () => {
    // Start B 104, then "A" (33) at weight 1: (104 + 33) % 103 = 34.
    expect(code128Values("A")).toEqual([104, 33, 34, 106])
    expect(code128Modules("GGS7F3K2Q")).toHaveLength(11 + 9 * 11 + 11 + 13)
    expect(() => code128Modules("£")).toThrow()
  })
})

describe("the price label barcode", () => {
  const sku = buildCode("single", "7F3K2").encoded

  it("encodes exactly the Barcode the Epos sync sends: the SKU without its hyphen", () => {
    expect(eposBarcode(sku)).toBe(sku)
    expect(eposBarcode(buildCode("single", "7F3K2").display)).toBe(sku)
    expect(sku).not.toContain("-")
    const layout = priceLabelLayout({ title: "Charizard ex #199", price: 22999, sku }, priceLabelSize("12x40"), measure)
    const bar = layout.ops.find((op): op is BarcodeOp => op.kind === "barcode")
    expect(bar?.value).toBe(sku)
  })

  it("is 2 dots a module on the 40 mm label, with a full quiet zone", () => {
    const layout = priceLabelLayout({ title: "Charizard ex #199", price: 22999, sku }, priceLabelSize("12x40"), measure)
    const bar = layout.ops.find((op): op is BarcodeOp => op.kind === "barcode") as BarcodeOp
    expect(bar.module).toBe(2)
    expect(bar.x).toBeGreaterThanOrEqual(QUIET_ZONE * 2)
    expect(320 - (bar.x + bar.width)).toBeGreaterThanOrEqual(QUIET_ZONE * 2)
    expect(bar).toMatchObject({ y: PAD_Y, height: BARCODE_HEIGHT.named })
    // Whole dots only.
    for (const rect of barcodeRects(bar)) {
      expect(Number.isInteger(rect.x)).toBe(true)
      expect(rect.width % 2).toBe(0)
    }
  })

  for (const size of PRICE_LABEL_SIZES) {
    it(`decodes back to the SKU at the printer's resolution on the ${size.name} label`, async () => {
      const layout = priceLabelLayout({ title: "Pokemon Pitch Black Booster Pack", price: 599, sku }, size, measure)
      const bar = layout.ops.find((op): op is BarcodeOp => op.kind === "barcode") as BarcodeOp
      const read = await readBarcodes(rasterBars(bar, size.width, size.height), { formats: ["Code128"], tryHarder: true })
      expect(read.map((r) => r.text)).toEqual([sku])
    })
  }

  it("keeps the price on the label and clear of the bars", () => {
    for (const size of PRICE_LABEL_SIZES) {
      const layout = priceLabelLayout({ title: "Pokemon Pitch Black Booster Pack", price: 123456, sku }, size, measure)
      const bar = layout.ops.find((op): op is BarcodeOp => op.kind === "barcode") as BarcodeOp
      const texts = layout.ops.filter((op): op is TextOp => op.kind === "text")
      const price = texts.find((op) => op.font.family === "Anton") as TextOp
      expect(price.text).toBe("£1,234.56")
      for (const op of texts) {
        expect(op.y - Math.round(op.font.size * 0.95)).toBeGreaterThanOrEqual(bar.y + bar.height)
        expect(op.y).toBeLessThanOrEqual(size.height - PAD_Y)
      }
      if (size.width >= 240) expect(texts.some((op) => op.font.family === "Poppins")).toBe(true)
    }
  })
})
