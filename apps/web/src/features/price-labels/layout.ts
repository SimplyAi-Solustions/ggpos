/**
 * The price label for the Niimbot D110: the GG logo, the item's name and its
 * price, on a 12 mm tall label.
 *
 * The D110 prints 8 dots to the millimetre through a 96-dot head, and its
 * labels feed long side first, so a 12 x 40 mm label is drawn here as a
 * 320 x 96 landscape and turned a quarter for the head when it is encoded
 * (`printDirection: "left"` in niimbluelib). One unit is one dot.
 *
 *   ┌──────────────────────────────────────┐
 *   │ Wednesday: Creatures and Outcasts    │  the name, Jost 500, two lines at most
 *   │                                      │
 *   │ GG                           £15.00  │  the logo and the price share the bottom
 *   └──────────────────────────────────────┘
 *
 * A label shorter than 30 mm has no room for the name, so it carries the
 * logo and a bigger price only. Nothing here touches a canvas: the painter in
 * `features/printing/receipt/paint.ts` draws the same ops a receipt uses.
 */
import { formatGBP } from "@gg/shared"

import {
  lineBox,
  logoWidth,
  wrapText,
  type DrawOp,
  type FontSpec,
  type Layout,
  type Measure,
} from "@/features/printing/receipt/draw"

/** The D110's resolution: 203 dpi is 8 dots to the millimetre. */
export const DOTS_PER_MM = 8

export type PriceLabelSizeKey = "12x40" | "12x30" | "12x22"

export interface PriceLabelSize {
  key: PriceLabelSizeKey
  /** What the size is called on screen. */
  name: string
  /** Along the roll, in dots. */
  width: number
  /** Across the head, in dots. */
  height: number
}

/** The D110 rolls the shop can load, the usual one first. */
export const PRICE_LABEL_SIZES: readonly PriceLabelSize[] = [
  { key: "12x40", name: "12 x 40 mm", width: 40 * DOTS_PER_MM, height: 12 * DOTS_PER_MM },
  { key: "12x30", name: "12 x 30 mm", width: 30 * DOTS_PER_MM, height: 12 * DOTS_PER_MM },
  { key: "12x22", name: "12 x 22 mm", width: 22 * DOTS_PER_MM, height: 12 * DOTS_PER_MM },
]

export const DEFAULT_PRICE_LABEL_SIZE: PriceLabelSizeKey = "12x40"

export function priceLabelSize(key: string | null | undefined): PriceLabelSize {
  return (
    PRICE_LABEL_SIZES.find((size) => size.key === key) ??
    (PRICE_LABEL_SIZES[0] as PriceLabelSize)
  )
}

/** What one label says. `price` is pence. */
export interface PriceLabelContent {
  title: string
  price: number
}

/** Kept clear at the ends of the label, where a roll can drift a dot or two. */
export const PAD_X = 12
/** Kept clear top and bottom: the head is exactly as tall as the label. */
export const PAD_Y = 8
/** Room between the logo and the price. */
const GAP = 12
/** Labels shorter than this carry no name. */
const NAMED_FROM = 30 * DOTS_PER_MM

export const TITLE_FONT: FontSpec = { family: "Jost Variable", size: 17, weight: 500 }
const TITLE_LINES = 2
const LOGO_HEIGHT = 24

/** The price at its full size, then smaller until it fits the room left. */
const PRICE_SIZE = { named: 38, alone: 48, least: 24 } as const

const ELLIPSIS = "…"

/**
 * `text` in at most `lines` lines no wider than `maxWidth`, the last one cut
 * with an ellipsis when the rest would not fit.
 */
export function clampLines(
  text: string,
  maxWidth: number,
  lines: number,
  font: FontSpec,
  measure: Measure
): string[] {
  const all = wrapText(text.trim().replace(/\s+/g, " "), maxWidth, font, measure).filter(Boolean)
  if (all.length <= lines) return all
  const kept = all.slice(0, lines - 1)
  let last = all.slice(lines - 1).join(" ")
  while (last && measure(`${last}${ELLIPSIS}`, font) > maxWidth) {
    last = last.slice(0, -1)
  }
  kept.push(`${last.trimEnd()}${ELLIPSIS}`)
  return kept
}

/** The largest price size from `start` down that fits `room` dots across. */
function fitPrice(text: string, room: number, start: number, measure: Measure): FontSpec {
  let size = start
  const font = (at: number): FontSpec => ({ family: "Anton", size: at, weight: 400 })
  while (size > PRICE_SIZE.least && measure(text, font(size)) > room) size -= 1
  return font(size)
}

export function priceLabelLayout(
  content: PriceLabelContent,
  size: PriceLabelSize,
  measure: Measure
): Layout {
  const { width, height } = size
  const inner = width - PAD_X * 2
  const ops: DrawOp[] = []
  const baseline = height - PAD_Y
  const named = width >= NAMED_FROM

  // The logo sits on the bottom line on a named label, and in the top
  // corner on a short one, where the price takes the bottom line alone.
  const logo = logoWidth(LOGO_HEIGHT)
  ops.push({
    kind: "logo",
    x: PAD_X,
    y: named ? baseline - LOGO_HEIGHT : PAD_Y,
    height: LOGO_HEIGHT,
  })

  if (named && content.title.trim()) {
    const box = lineBox(TITLE_FONT)
    let top = PAD_Y
    for (const line of clampLines(content.title, inner, TITLE_LINES, TITLE_FONT, measure)) {
      ops.push({ kind: "text", text: line, x: PAD_X, y: top + box.above, align: "left", font: TITLE_FONT })
      top += box.above + box.below
    }
  }

  const price = formatGBP(content.price)
  const room = named ? inner - logo - GAP : inner
  const font = fitPrice(price, room, named ? PRICE_SIZE.named : PRICE_SIZE.alone, measure)
  ops.push({ kind: "text", text: price, x: width - PAD_X, y: baseline, align: "right", font })

  return { width, height, ops }
}

/** Every character a set of labels will draw, for loading the fonts first. */
export function labelText(contents: readonly PriceLabelContent[]): string {
  return `${contents.map((content) => `${content.title} ${formatGBP(content.price)}`).join(" ")}${ELLIPSIS}`
}
