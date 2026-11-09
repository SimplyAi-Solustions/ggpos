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
 *   │   ||| |||| | ||| || |||| | || |||    │  Code 128 of the SKU, for the Epos Now till
 *   │ Wednesday: Creatures and Outc…       │  the name, one line
 *   │ GG                           £15.00  │  the logo and the price share the bottom
 *   └──────────────────────────────────────┘
 *
 * The barcode is the SKU exactly as Epos Now has it as the product's Barcode
 * (`eposBarcode`), as wide as the label allows in whole dots per module with
 * at least the standard 10-module quiet zone each side: 2 dots a module on a
 * 40 mm label, 1 dot on 30 and 22 mm, which only good scanners read. Use
 * the 40 mm roll for anything sold on the Epos till.
 *
 * A label shorter than 30 mm has no room for the name. A label with no SKU
 * keeps the older layout: the name on two lines, the logo and the price. Nothing here touches a canvas: the painter in
 * `features/printing/receipt/paint.ts` draws the same ops a receipt uses.
 */
import { formatGBP } from "@gg/shared"

import { code128Modules, eposBarcode, QUIET_ZONE } from "./code128"

import {
  type BarcodeOp,
  lineBox,
  logoWidth,
  wrapText,
  type DrawOp,
  type FontSpec,
  type Layout,
  type Measure,
} from "./draw"

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

/** What one label says. `price` is pence. With a `sku` it carries the barcode. */
export interface PriceLabelContent {
  title: string
  price: number
  sku?: string
}

/** Kept clear at the ends of the label, where a roll can drift a dot or two. */
export const PAD_X = 12
/** Kept clear top and bottom: the head is exactly as tall as the label. */
export const PAD_Y = 8
/** Room between the logo and the price. */
const GAP = 12
/** Labels shorter than this carry no name. */
const NAMED_FROM = 30 * DOTS_PER_MM

export const TITLE_FONT: FontSpec = { family: "Poppins", size: 17, weight: 500 }
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

/** Bars on a named label, and on a short one where the name is left off. */
export const BARCODE_HEIGHT = { named: 30, alone: 36 } as const
const BARCODE_TITLE_FONT: FontSpec = { family: "Poppins", size: 15, weight: 500 }
const BARCODE_LOGO_HEIGHT = 20
const BARCODE_PRICE_SIZE = { named: 28, alone: 40 } as const

/**
 * The barcode op for a value across a label `width` dots long: whole dots
 * per module, centred, with at least QUIET_ZONE modules clear each side.
 * Null when even one dot a module will not fit.
 */
export function barcodeOp(value: string, width: number, y: number, height: number): BarcodeOp | null {
  const modules = code128Modules(value).length
  const module = Math.floor(width / (modules + QUIET_ZONE * 2))
  if (module < 1) return null
  const bars = modules * module
  return { kind: "barcode", value, x: Math.floor((width - bars) / 2), y, width: bars, height, module }
}

export function priceLabelLayout(
  content: PriceLabelContent,
  size: PriceLabelSize,
  measure: Measure
): Layout {
  const { width, height } = size
  const named = width >= NAMED_FROM
  const barcode = content.sku
    ? barcodeOp(eposBarcode(content.sku), width, PAD_Y, named ? BARCODE_HEIGHT.named : BARCODE_HEIGHT.alone)
    : null
  if (barcode) return barcodeLabel(content, size, barcode, measure)
  const inner = width - PAD_X * 2
  const ops: DrawOp[] = []
  const baseline = height - PAD_Y

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

/** The barcode across the top, the name on one line, the logo and the price below. */
function barcodeLabel(content: PriceLabelContent, size: PriceLabelSize, barcode: BarcodeOp, measure: Measure): Layout {
  const { width, height } = size
  const inner = width - PAD_X * 2
  const baseline = height - PAD_Y
  const named = width >= NAMED_FROM
  const ops: DrawOp[] = [barcode]

  if (named && content.title.trim()) {
    const box = lineBox(BARCODE_TITLE_FONT)
    const [line] = clampLines(content.title, inner, 1, BARCODE_TITLE_FONT, measure)
    if (line) {
      ops.push({ kind: "text", text: line, x: PAD_X, y: barcode.y + barcode.height + 3 + box.above, align: "left", font: BARCODE_TITLE_FONT })
    }
  }

  // The logo only where there is room for it beside the price.
  let room = inner
  if (named) {
    ops.push({ kind: "logo", x: PAD_X, y: baseline - BARCODE_LOGO_HEIGHT, height: BARCODE_LOGO_HEIGHT })
    room = inner - logoWidth(BARCODE_LOGO_HEIGHT) - GAP
  }
  const price = formatGBP(content.price)
  const font = fitPrice(price, room, named ? BARCODE_PRICE_SIZE.named : BARCODE_PRICE_SIZE.alone, measure)
  ops.push({ kind: "text", text: price, x: width - PAD_X, y: baseline, align: "right", font })
  return { width, height, ops }
}

/** Every character a set of labels will draw, for loading the fonts first. */
export function labelText(contents: readonly PriceLabelContent[]): string {
  return `${contents.map((content) => `${content.title} ${formatGBP(content.price)}`).join(" ")}${ELLIPSIS}`
}
