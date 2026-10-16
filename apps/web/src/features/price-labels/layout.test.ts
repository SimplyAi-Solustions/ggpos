import { describe, expect, it } from "vitest"

import { lineBox, type FontSpec, type LogoOp, type Measure, type TextOp } from "@/features/printing/receipt/draw"

import {
  clampLines,
  PAD_X,
  PAD_Y,
  priceLabelLayout,
  priceLabelSize,
  PRICE_LABEL_SIZES,
  TITLE_FONT,
  labelText,
} from "./layout"

/** A fixed width per character: half the size for Jost, 0.45 for Anton. */
const measure: Measure = (text, font) =>
  Array.from(text).length * font.size * (font.family === "Anton" ? 0.45 : 0.5)

const texts = (ops: readonly { kind: string }[]) => ops.filter((op): op is TextOp => op.kind === "text")
const logoOf = (ops: readonly { kind: string }[]) => ops.find((op): op is LogoOp => op.kind === "logo")

/** Where a text op's ink reaches, left and right, by its alignment. */
function span(op: TextOp): [number, number] {
  const width = measure(op.text, op.font)
  if (op.align === "right") return [op.x - width, op.x]
  if (op.align === "center") return [op.x - width / 2, op.x + width / 2]
  return [op.x, op.x + width]
}

function top(op: TextOp): number {
  return op.y - lineBox(op.font).above
}

describe("the D110 price label", () => {
  it("is 40 by 12 mm at 8 dots a millimetre, the 12 x 40 mm roll first", () => {
    expect(PRICE_LABEL_SIZES[0]).toMatchObject({ key: "12x40", width: 320, height: 96 })
    expect(priceLabelSize("nonsense").key).toBe("12x40")
    expect(priceLabelSize("12x22")).toMatchObject({ width: 176, height: 96 })
  })

  it("puts the name at the top, and the logo and the price on the bottom line", () => {
    const layout = priceLabelLayout(
      { title: "Wednesday: Creatures and Outcasts", price: 1500 },
      priceLabelSize("12x40"),
      measure
    )
    expect(layout).toMatchObject({ width: 320, height: 96 })

    const [title, price] = texts(layout.ops)
    expect(title).toMatchObject({ text: "Wednesday: Creatures and Outcasts", x: PAD_X, align: "left" })
    expect(price).toMatchObject({ text: "£15.00", x: 320 - PAD_X, y: 96 - PAD_Y, align: "right" })
    expect(price?.font.family).toBe("Anton")

    const logo = logoOf(layout.ops)
    expect(logo).toMatchObject({ x: PAD_X, height: 24 })
    expect((logo?.y ?? 0) + (logo?.height ?? 0)).toBe(96 - PAD_Y)
  })

  it("wraps a long name to two lines and cuts the second with an ellipsis", () => {
    const layout = priceLabelLayout(
      {
        title: "Warhammer 40,000 Combat Patrol: Space Marines with the Captain in Gravis Armour and friends",
        price: 10500,
      },
      priceLabelSize("12x40"),
      measure
    )
    const lines = texts(layout.ops).filter((op) => op.font.family === "Jost Variable")
    expect(lines).toHaveLength(2)
    expect(lines[1]?.text.endsWith("…")).toBe(true)
    for (const line of lines) {
      const [left, right] = span(line)
      expect(left).toBeGreaterThanOrEqual(PAD_X)
      expect(right).toBeLessThanOrEqual(320 - PAD_X)
    }
  })

  it("never lets the name run into the price or off the label", () => {
    for (const size of PRICE_LABEL_SIZES) {
      const layout = priceLabelLayout(
        { title: "Pokémon TCG: Scarlet and Violet 151 Ultra Premium Collection", price: 123456 },
        size,
        measure
      )
      const all = texts(layout.ops)
      const price = all.find((op) => op.font.family === "Anton")
      const names = all.filter((op) => op.font.family === "Jost Variable")
      expect(price).toBeDefined()
      for (const op of all) {
        const [left, right] = span(op)
        expect(left).toBeGreaterThanOrEqual(PAD_X - 0.001)
        expect(right).toBeLessThanOrEqual(size.width - PAD_X + 0.001)
        expect(top(op)).toBeGreaterThanOrEqual(PAD_Y)
      }
      for (const name of names) {
        expect(name.y + lineBox(name.font).below).toBeLessThanOrEqual(top(price as TextOp))
      }
      // The price clears the logo on the bottom line.
      const logo = logoOf(layout.ops)
      if (logo && logo.y + logo.height > top(price as TextOp)) {
        const logoRight = logo.x + Math.round((logo.height * 316.32) / 100)
        expect(span(price as TextOp)[0]).toBeGreaterThan(logoRight)
      }
    }
  })

  it("leaves the name off a 22 mm label and gives the price the room", () => {
    const layout = priceLabelLayout({ title: "Booster pack", price: 499 }, priceLabelSize("12x22"), measure)
    const all = texts(layout.ops)
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ text: "£4.99", align: "right" })
    expect(all[0]?.font.size).toBe(48)
    expect(logoOf(layout.ops)).toMatchObject({ y: PAD_Y })
  })

  it("brings a long price down in size until it fits beside the logo", () => {
    const layout = priceLabelLayout({ title: "Graded slab", price: 1234567 }, priceLabelSize("12x30"), measure)
    const price = texts(layout.ops).find((op) => op.font.family === "Anton") as TextOp
    expect(price.text).toBe("£12,345.67")
    expect(price.font.size).toBeLessThan(38)
    expect(span(price)[1]).toBe(240 - PAD_X)
  })

  it("prints the logo and the price alone when there is no name", () => {
    const layout = priceLabelLayout({ title: "   ", price: 250 }, priceLabelSize("12x40"), measure)
    expect(texts(layout.ops).map((op) => op.text)).toEqual(["£2.50"])
  })

  it("names every character the labels will draw, so the fonts load first", () => {
    expect(labelText([{ title: "Pokémon", price: 45 }])).toContain("Pokémon £0.45")
    expect(labelText([])).toContain("…")
  })
})

describe("clampLines", () => {
  const font: FontSpec = TITLE_FONT

  it("keeps a short name whole", () => {
    expect(clampLines("Catan", 200, 2, font, measure)).toEqual(["Catan"])
  })

  it("collapses runs of spaces before wrapping", () => {
    expect(clampLines("  Ticket   to  Ride ", 400, 2, font, measure)).toEqual(["Ticket to Ride"])
  })

  it("cuts a word too long for the line rather than running off it", () => {
    const lines = clampLines("Supercalifragilisticexpialidociousandthensome", 100, 2, font, measure)
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(measure(line, font)).toBeLessThanOrEqual(100)
  })
})
