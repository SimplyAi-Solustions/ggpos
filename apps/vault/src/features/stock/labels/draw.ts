/**
 * Ported from apps/web (features/printing/receipt/draw.ts) for the price label: the vocabulary a label is laid out in,
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
import { LOGO } from "@/brand/logo-paths"

export type FontFamily = "Anton" | "Space Mono" | "Poppins"

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

/**
 * The GG Entertainment lockup in one colour, both Gs filled with ink and no
 * outline (`GGLogo mono`), `height` dots tall with its top-left corner here.
 * The Niimbot price label carries it.
 */
export interface LogoOp {
  kind: "logo"
  x: number
  y: number
  height: number
}

export type DrawOp = TextOp | RuleOp | BarcodeOp | QrOp | LogoOp

export interface Layout {
  /** A receipt's `PaperWidth`, or a label's length in dots. */
  width: number
  height: number
  ops: DrawOp[]
}

/** The lockup's width for a height, from its traced view box. */
export function logoWidth(height: number): number {
  const [, , width = 0, tall = 1] = LOGO.viewBox.split(" ").map(Number)
  return Math.round((height * width) / tall)
}

/** The width of `text` set in `font`, in dots. */
export type Measure = (text: string, font: FontSpec) => number

// ---------------------------------------------------------------------------
// Fonts. The three faces are the app's own (DESIGN.md, section 2): Anton for
// the shop name and the total, Space Mono for labels and codes, Poppins for
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
  "Poppins": { ascent: 0.82, descent: 0.25, lineHeight: 1.28 },
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
