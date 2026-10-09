/**
 * The vocabulary a receipt or a report is laid out in: a flat list of draw
 * operations with pixel positions, and the little page builder that makes it.
 *
 * Nothing here touches a canvas. The layout is plain data so Vitest can check
 * wrapping, alignment and the gift and refund variants without one; the
 * painter (`paint.ts`) turns the same list into pixels. Text is measured
 * through a `Measure` the caller supplies: the canvas's own `measureText` in
 * the browser, a fixed width per character in the tests.
 *
 * Everything is in printer dots. The Star printers print an image pixel for
 * pixel, 576 across on 80 mm paper and 384 on 58 mm, so one unit here is one
 * dot and there is no scaling anywhere downstream.
 */

export type PaperWidth = 576 | 384

/** The dots a printer prints across for its paper: 576 on 80 mm, 384 on 58 mm. */
export function dotsFor(paperMm: number): PaperWidth {
  return paperMm === 58 ? 384 : 576
}

export type FontFamily = "Anton" | "Space Mono" | "Jost Variable"

export interface FontSpec {
  family: FontFamily
  /** Dots. */
  size: number
  weight: 300 | 400 | 500 | 700
  /** Extra dots after each letter. The tracked mono labels use it. */
  tracking?: number
}

export type Align = "left" | "center" | "right"

export interface TextOp {
  kind: "text"
  text: string
  /** Left edge, centre or right edge, by `align`. */
  x: number
  /** The text's baseline. */
  y: number
  align: Align
  font: FontSpec
}

export interface RuleOp {
  kind: "rule"
  x: number
  y: number
  width: number
  thickness: number
  dashed: boolean
}

/** A Code 128 barcode, fitted by the painter inside this box and centred in it. */
export interface BarcodeOp {
  kind: "barcode"
  value: string
  x: number
  y: number
  width: number
  height: number
}

/** A QR code, fitted by the painter inside this square and centred in it. */
export interface QrOp {
  kind: "qr"
  value: string
  x: number
  y: number
  size: number
}

export type DrawOp = TextOp | RuleOp | BarcodeOp | QrOp

export interface Layout {
  width: PaperWidth
  height: number
  ops: DrawOp[]
}

/** The width of `text` set in `font`, in dots. */
export type Measure = (text: string, font: FontSpec) => number

// ---------------------------------------------------------------------------
// Fonts. The three faces are the app's own (DESIGN.md, section 2): Anton for
// the shop name and the total, Space Mono for labels and codes, Jost for
// everything a person reads.
// ---------------------------------------------------------------------------

/**
 * Where a font's baseline sits in its line box, as fractions of the size.
 * These are deliberately a touch generous: a baseline that is a few dots too
 * low only adds air, while one too high would clip the top of a capital.
 */
const METRICS: Record<FontFamily, { ascent: number; descent: number; lineHeight: number }> = {
  Anton: { ascent: 0.95, descent: 0.25, lineHeight: 1.2 },
  "Space Mono": { ascent: 0.82, descent: 0.25, lineHeight: 1.3 },
  "Jost Variable": { ascent: 0.82, descent: 0.25, lineHeight: 1.28 },
}

/** Dots from the top of a line box to the baseline, and from the baseline to its bottom. */
export function lineBox(font: FontSpec): { above: number; below: number } {
  const m = METRICS[font.family]
  const leading = Math.max(0, (m.lineHeight - m.ascent - m.descent) * font.size)
  return {
    above: Math.round(m.ascent * font.size + leading / 2),
    below: Math.round(m.descent * font.size + leading / 2),
  }
}

export function lineHeightOf(font: FontSpec): number {
  const box = lineBox(font)
  return box.above + box.below
}

/** The CSS font shorthand for a spec, as the canvas wants it. */
export function fontString(font: FontSpec): string {
  return `${font.weight} ${font.size}px "${font.family}"`
}

/** The few faces a receipt uses, by role, at the size for 80 mm paper. */
export const FACE = {
  display: (size: number): FontSpec => ({ family: "Anton", size, weight: 400 }),
  mono: (size: number): FontSpec => ({ family: "Space Mono", size, weight: 400 }),
  monoBold: (size: number, tracking = 2): FontSpec => ({
    family: "Space Mono",
    size,
    weight: 700,
    tracking,
  }),
  sans: (size: number): FontSpec => ({ family: "Jost Variable", size, weight: 400 }),
  sansMedium: (size: number): FontSpec => ({ family: "Jost Variable", size, weight: 500 }),
} as const

// ---------------------------------------------------------------------------
// Wrapping
// ---------------------------------------------------------------------------

/**
 * `text` broken into lines no wider than `maxWidth`. Words stay whole unless
 * one is wider than a line on its own, in which case it is split by letter,
 * so a long code or an unbroken title never runs off the paper. A newline in
 * the text is a line break; a blank line is kept as an empty string.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  font: FontSpec,
  measure: Measure
): string[] {
  const out: string[] = []
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      out.push("")
      continue
    }
    let line = ""
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (measure(candidate, font) <= maxWidth) {
        line = candidate
        continue
      }
      if (line) out.push(line)
      if (measure(word, font) <= maxWidth) {
        line = word
        continue
      }
      let piece = ""
      for (const letter of Array.from(word)) {
        if (piece === "" || measure(piece + letter, font) <= maxWidth) {
          piece += letter
        } else {
          out.push(piece)
          piece = letter
        }
      }
      line = piece
    }
    if (line) out.push(line)
  }
  return out
}

// ---------------------------------------------------------------------------
// The page builder
// ---------------------------------------------------------------------------

export interface Column {
  text: string
  /** Where this column's right edge is, in dots from the left of the page. */
  right: number
}

export interface Page {
  readonly width: PaperWidth
  /** Side margin. */
  readonly pad: number
  /** The width between the margins. */
  readonly inner: number
  /** The top of the next row. */
  readonly cursor: number
  /** Blank space. */
  gap(dots: number): void
  /** One unwrapped line. */
  line(text: string, font: FontSpec, align?: Align): void
  /** Wrapped lines at the full inner width. A blank line is a half-height gap. */
  wrap(text: string, font: FontSpec, align?: Align): void
  /**
   * A label on the left and a value on the right, sharing a baseline. The
   * label wraps in what the value leaves; the value stays on the first line.
   */
  row(left: string, right: string, leftFont: FontSpec, rightFont?: FontSpec): void
  /** Right-aligned cells on one baseline, for a table row. */
  columns(cells: Column[], font: FontSpec): void
  rule(opts?: { thickness?: number; dashed?: boolean }): void
  barcode(value: string, height: number): void
  qr(value: string, size: number): void
  finish(bottomPad: number): Layout
}

/** A distance kept between a row's label and its value. */
const ROW_GUTTER = 24

export function createPage(width: PaperWidth, measure: Measure): Page {
  const pad = width === 576 ? 14 : 10
  const inner = width - pad * 2
  const ops: DrawOp[] = []
  let y = 0

  function textOp(text: string, font: FontSpec, x: number, baseline: number, align: Align) {
    ops.push({ kind: "text", text, x, y: baseline, align, font })
  }

  function anchor(align: Align): number {
    return align === "left" ? pad : align === "right" ? width - pad : width / 2
  }

  const page: Page = {
    width,
    pad,
    inner,
    get cursor() {
      return y
    },
    gap(dots) {
      y += dots
    },
    line(text, font, align = "left") {
      const box = lineBox(font)
      textOp(text, font, anchor(align), y + box.above, align)
      y += box.above + box.below
    },
    wrap(text, font, align = "left") {
      for (const line of wrapText(text, inner, font, measure)) {
        if (line === "") {
          y += Math.round(lineHeightOf(font) / 2)
        } else {
          page.line(line, font, align)
        }
      }
    },
    row(left, right, leftFont, rightFont = leftFont) {
      const rightWidth = right ? measure(right, rightFont) : 0
      const room = inner - (right ? rightWidth + ROW_GUTTER : 0)
      const lines = left ? wrapText(left, room, leftFont, measure) : [""]
      const firstBox = lineBox(leftFont)
      const rightBox = lineBox(rightFont)
      // One baseline for the label's first line and the value, whichever is taller.
      const above = Math.max(firstBox.above, right ? rightBox.above : 0)
      const baseline = y + above
      if (lines[0]) textOp(lines[0], leftFont, pad, baseline, "left")
      if (right) textOp(right, rightFont, width - pad, baseline, "right")
      const below = Math.max(firstBox.below, right ? rightBox.below : 0)
      y += above + below
      for (let i = 1; i < lines.length; i++) {
        const box = lineBox(leftFont)
        textOp(lines[i] ?? "", leftFont, pad, y + box.above, "left")
        y += box.above + box.below
      }
    },
    columns(cells, font) {
      const box = lineBox(font)
      for (const cell of cells) textOp(cell.text, font, cell.right, y + box.above, "right")
      y += box.above + box.below
    },
    rule(opts) {
      const thickness = opts?.thickness ?? 2
      y += 6
      ops.push({
        kind: "rule",
        x: pad,
        y,
        width: inner,
        thickness,
        dashed: opts?.dashed ?? false,
      })
      y += thickness + 6
    },
    barcode(value, height) {
      ops.push({ kind: "barcode", value, x: pad, y, width: inner, height })
      y += height
    },
    qr(value, size) {
      ops.push({ kind: "qr", value, x: Math.round((width - size) / 2), y, size })
      y += size
    },
    finish(bottomPad) {
      return { width, height: Math.ceil(y + bottomPad), ops }
    },
  }
  return page
}

/**
 * Sizes that follow the paper. Body text keeps its size on narrow paper
 * (a thermal printer's 58 mm font is the same dots as its 80 mm one, just
 * fewer to a line); only the big display sizes come down.
 */
export function displaySize(size: number, width: PaperWidth): number {
  return width === 576 ? size : Math.round(size * 0.8)
}
