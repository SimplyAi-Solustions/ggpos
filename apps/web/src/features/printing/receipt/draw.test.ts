import { describe, expect, it } from "vitest"

import {
  createPage,
  displaySize,
  dotsFor,
  FACE,
  lineBox,
  lineHeightOf,
  wrapText,
  type FontSpec,
  type Measure,
  type TextOp,
} from "./draw"

/** Every character is half the font size wide, plus its tracking: easy to reason about. */
const measure: Measure = (text: string, font: FontSpec) =>
  Array.from(text).length * (font.size * 0.5 + (font.tracking ?? 0))

const body = FACE.sans(20) // 10 dots a character

function texts(ops: ReturnType<ReturnType<typeof createPage>["finish"]>["ops"]): TextOp[] {
  return ops.filter((op): op is TextOp => op.kind === "text")
}

describe("wrapText", () => {
  it("keeps words whole and breaks between them", () => {
    // 10 dots a character, 100 dots a line: ten characters.
    expect(wrapText("one two three four", 100, body, measure)).toEqual(["one two", "three four"])
  })

  it("breaks a word wider than a line by letter instead of running off the paper", () => {
    expect(wrapText("abcdefghijklmnop", 100, body, measure)).toEqual(["abcdefghij", "klmnop"])
  })

  it("starts a long word on its own line after the words before it", () => {
    expect(wrapText("hi abcdefghijklmn", 100, body, measure)).toEqual(["hi", "abcdefghij", "klmn"])
  })

  it("treats a newline as a line break and keeps a blank line", () => {
    expect(wrapText("first\n\nsecond", 100, body, measure)).toEqual(["first", "", "second"])
  })

  it("does not split a surrogate pair", () => {
    const lines = wrapText("\u{1F3AE}\u{1F3AE}\u{1F3AE}", 15, body, measure)
    expect(lines.join("")).toBe("\u{1F3AE}\u{1F3AE}\u{1F3AE}")
    for (const line of lines) expect(Array.from(line).length).toBe(1)
  })

  it("returns one empty line for no text, which callers skip", () => {
    expect(wrapText("", 100, body, measure)).toEqual([""])
  })
})

describe("paper", () => {
  it("is 576 dots on 80 mm and 384 on 58 mm", () => {
    expect(dotsFor(80)).toBe(576)
    expect(dotsFor(58)).toBe(384)
  })

  it("brings only the display sizes down on narrow paper", () => {
    expect(displaySize(56, 576)).toBe(56)
    expect(displaySize(56, 384)).toBe(45)
  })
})

describe("line boxes", () => {
  it("put the baseline inside the line, below its top, and grow with the size", () => {
    for (const font of [FACE.display(56), FACE.mono(20), FACE.sans(24)]) {
      const box = lineBox(font)
      expect(box.above).toBeGreaterThan(0)
      expect(box.below).toBeGreaterThan(0)
      expect(lineHeightOf(font)).toBe(box.above + box.below)
    }
    expect(lineHeightOf(FACE.sans(48))).toBeGreaterThan(lineHeightOf(FACE.sans(24)))
  })
})

describe("the page builder", () => {
  it("anchors left, centred and right text at the margins and the middle", () => {
    const page = createPage(576, measure)
    page.line("left", body, "left")
    page.line("middle", body, "center")
    page.line("right", body, "right")
    const [left, middle, right] = texts(page.finish(0).ops)
    expect(left).toMatchObject({ x: page.pad, align: "left" })
    expect(middle).toMatchObject({ x: 288, align: "center" })
    expect(right).toMatchObject({ x: 576 - page.pad, align: "right" })
  })

  it("moves down by a line each time and by gaps on request", () => {
    const page = createPage(576, measure)
    const start = page.cursor
    page.line("a", body)
    const afterOne = page.cursor
    page.gap(10)
    page.line("b", body)
    expect(afterOne - start).toBe(lineHeightOf(body))
    expect(page.cursor - afterOne).toBe(10 + lineHeightOf(body))
    const [a, b] = texts(page.finish(0).ops)
    expect((b?.y ?? 0) - (a?.y ?? 0)).toBe(10 + lineHeightOf(body))
  })

  it("puts a row's label and value on one baseline, the value flush right", () => {
    const page = createPage(576, measure)
    page.row("TOTAL", "£53.67", FACE.monoBold(24, 3), FACE.display(54))
    const [label, value] = texts(page.finish(0).ops)
    expect(label?.align).toBe("left")
    expect(value?.align).toBe("right")
    expect(value?.x).toBe(576 - page.pad)
    expect(label?.y).toBe(value?.y)
  })

  it("wraps a row's label into what the value leaves and keeps the value on the first line", () => {
    const page = createPage(576, measure)
    // 548 inner, value 60 wide plus the gutter leaves room for far fewer than 60 characters.
    const long = "Dragon Shield matte sleeves in black, a pack of one hundred"
    page.row(long, "£8.99", body)
    const ops = texts(page.finish(0).ops)
    const labels = ops.filter((op) => op.align === "left")
    expect(labels.length).toBeGreaterThan(1)
    const value = ops.find((op) => op.align === "right")
    expect(value?.y).toBe(labels[0]?.y)
    // Every label line fits beside the value and the 24 dots kept clear of it.
    const room = 548 - measure("£8.99", body) - 24
    for (const label of labels) {
      expect(measure(label.text, label.font)).toBeLessThanOrEqual(room)
    }
    // Later label lines are below the first.
    expect(labels[1]?.y).toBeGreaterThan(labels[0]?.y ?? 0)
  })

  it("draws a row that has no value at the full width", () => {
    const page = createPage(576, measure)
    page.row("only a label", "", body)
    const ops = texts(page.finish(0).ops)
    expect(ops).toHaveLength(1)
    expect(ops[0]?.align).toBe("left")
  })

  it("lays table cells on one baseline at their right edges", () => {
    const page = createPage(576, measure)
    page.columns(
      [
        { text: "20%", right: 80 },
        { text: "£1.00", right: 230 },
      ],
      body
    )
    const ops = texts(page.finish(0).ops)
    expect(ops.map((op) => op.x)).toEqual([80, 230])
    expect(new Set(ops.map((op) => op.y)).size).toBe(1)
    expect(ops.every((op) => op.align === "right")).toBe(true)
  })

  it("makes the page as tall as what was drawn plus the bottom margin", () => {
    const page = createPage(576, measure)
    page.line("a", body)
    const end = page.cursor
    expect(page.finish(40).height).toBe(end + 40)
  })

  it("narrows its margins on 58 mm paper", () => {
    expect(createPage(384, measure).inner).toBe(384 - 2 * createPage(384, measure).pad)
    expect(createPage(384, measure).pad).toBeLessThan(createPage(576, measure).pad)
  })
})
