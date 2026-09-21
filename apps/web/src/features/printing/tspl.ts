/**
 * TSPL2: the commands the ORGSTA T003 takes, built from the same layout the
 * print page draws (docs/label-spec.md, "Printing path 2").
 *
 * Pure. No DOM, no WebUSB, no React: given a `labelLayout` result this
 * returns the exact text the printer reads, and the bytes that text becomes,
 * so both are unit tested character by character.
 *
 * Two things the printer is strict about:
 *
 * 1. Everything is in dots. The layout is in millimetres, because a browser
 *    print has to come out the right physical size whatever the screen is;
 *    here every figure goes through `DOTS_PER_MM` once, at the edge.
 * 2. Everything is one byte. `CODEPAGE 850` is sent so the pound sign is a
 *    single byte, 0x9C, which is the only character outside ASCII the shop's
 *    labels carry. Anything else non-ASCII is turned into its plain letter
 *    rather than sent as a byte the printer would draw as something else.
 */
import { DOTS_PER_MM, type LabelLayout, type LabelLine } from "@/features/labels/layout"

/** CP850's pound sign. `CODEPAGE 850` is what makes it one byte. */
export const POUND_BYTE = 0x9c

/** 1.5 mm of paper down each side, the same padding the print page leaves. */
const PADDING_MM = 1.5
/** Between the QR and the text column, and between two lines of text. */
const GAP_MM = 1.5
const LINE_GAP_MM = 0.6

function dots(mm: number): number {
  return Math.round(mm * DOTS_PER_MM)
}

/** A whole number where the size is whole, so `SIZE 40 mm,20 mm` reads plainly. */
function mm(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10)
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * The printer draws one byte per character, so a title arriving with a
 * curly apostrophe or an accent is written in the plain letters it stands
 * for. The pound sign is the one character kept as it is: `CODEPAGE 850`
 * gives it a byte of its own.
 */
const PLAIN: Record<string, string> = {
  "·": "-",
  "•": "-",
  // The three dashes, as escapes: en dash, em dash and non-breaking hyphen.
  // A dash that is not a hyphen has no byte on a thermal printer, and no
  // place in this repository's own prose either.
  "\u2013": "-",
  "\u2014": "-",
  "\u2011": "-",
  "’": "'",
  "‘": "'",
  "“": '"',
  "”": '"',
  "…": "...",
  "×": "x",
  "€": "EUR",
}

export function toPrintable(text: string): string {
  let out = ""
  // Decomposed first, so an accented letter arrives as its plain letter plus
  // a combining mark that the loop below drops.
  for (const char of text.normalize("NFD")) {
    const code = char.codePointAt(0) ?? 0
    // Control characters would be read as commands, so they never go out.
    if (code < 0x20 || code === 0x7f) continue
    if (code < 0x7f) {
      out += char
      continue
    }
    if (char === "£") {
      out += char
      continue
    }
    // Combining marks, left behind by the decomposition above.
    if (code >= 0x300 && code <= 0x36f) continue
    const plain = PLAIN[char]
    out += plain ?? "?"
  }
  return out
}

/** TSPL reads `"` as the end of an argument and `\` as its escape. */
export function escapeTspl(text: string): string {
  return toPrintable(text).replace(/[\\"]/g, "\\$&")
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

export interface TsplFont {
  /** The name TSPL knows it by, as it goes inside the quotes. */
  name: string
  /** One character's cell, in dots, at multiplier 1. */
  width: number
  height: number
}

/** The T003's built-in bitmap fonts. No font is downloaded to the printer. */
export const TSPL_FONTS: TsplFont[] = [
  { name: "1", width: 8, height: 12 },
  { name: "2", width: 12, height: 20 },
  { name: "3", width: 16, height: 24 },
  { name: "4", width: 24, height: 32 },
]

const MULTIPLIERS = [1, 2, 3, 4, 5, 6, 7, 8]

export interface FontChoice {
  font: TsplFont
  multiplier: number
  /** What that choice actually draws, in dots. */
  height: number
  width: number
}

/**
 * A multiplied bitmap font is the same glyph drawn in bigger squares, so
 * 8 x 12 tripled is a coarser 36 dots than 24 x 32 is at 32. Every step of
 * multiplication is charged this many dots of distance, which is what makes
 * a nearby larger font win over a blown-up small one.
 */
const MULTIPLIER_PENALTY = 1.5

/**
 * The built-in font and multiplier nearest a height the layout asked for.
 *
 * A bitmap font only comes in whole multiples of its own cell, so a
 * millimetre figure never lands exactly. Two choices the same distance from
 * the target are settled by taking the smaller one: a line that overflows
 * its label is worse than one a dot short. After that the larger base font
 * wins, because 16 x 24 is a crisper 24 dots than 8 x 12 doubled.
 */
export function fitFont(targetDots: number): FontChoice {
  let best: FontChoice | null = null
  const score = (choice: FontChoice) =>
    Math.abs(choice.height - targetDots) +
    (choice.multiplier - 1) * MULTIPLIER_PENALTY

  for (const font of TSPL_FONTS) {
    for (const multiplier of MULTIPLIERS) {
      const height = font.height * multiplier
      const choice: FontChoice = {
        font,
        multiplier,
        height,
        width: font.width * multiplier,
      }
      if (!best) {
        best = choice
        continue
      }
      const gap = score(choice)
      const bestGap = score(best)
      if (gap < bestGap) {
        best = choice
        continue
      }
      if (gap > bestGap) continue
      // Same score: under the target first, then the bigger cell.
      const under = height <= targetDots
      const bestUnder = best.height <= targetDots
      if (under !== bestUnder) {
        if (under) best = choice
        continue
      }
      if (font.height > best.font.height) best = choice
    }
  }
  // Every branch above assigns on the first pass, so this is only for the
  // type checker.
  return best ?? { font: TSPL_FONTS[0], multiplier: 1, height: 12, width: 8 }
}

/** As many characters as fit the column, with a plain ellipsis when they do not. */
export function fitText(text: string, charWidth: number, columnDots: number): string {
  const budget = Math.max(1, Math.floor(columnDots / charWidth))
  if (text.length <= budget) return text
  if (budget > 4) return `${text.slice(0, budget - 3)}...`
  return text.slice(0, budget)
}

// ---------------------------------------------------------------------------
// The QR
// ---------------------------------------------------------------------------

/** Alphanumeric mode's own alphabet: anything else makes it a byte payload. */
const ALPHANUMERIC = /^[0-9A-Z $%*+\-./:]*$/

/** Capacity at error correction L, versions 1 to 10, in characters. */
const ALPHANUMERIC_CAPACITY = [25, 47, 77, 114, 154, 195, 224, 279, 335, 395]
const BYTE_CAPACITY = [17, 32, 53, 78, 106, 134, 154, 192, 230, 271]

/**
 * How many modules across the symbol will be.
 *
 * The printer works this out itself; the counter needs the same answer up
 * front to choose a cell size that lands on the millimetres the label spec
 * asks for. Version N is 17 + 4N modules square.
 */
export function qrModules(text: string): number {
  const capacity = ALPHANUMERIC.test(text) ? ALPHANUMERIC_CAPACITY : BYTE_CAPACITY
  const version = capacity.findIndex((limit) => text.length <= limit)
  // Longer than version 10 holds at this correction level: the widest we
  // ever draw, and the printer will refuse rather than print a bad symbol.
  return 17 + 4 * (version === -1 ? capacity.length : version + 1)
}

/** The cell size in dots that brings the symbol nearest the spec's size. */
export function qrCell(text: string, targetDots: number): number {
  const cell = Math.floor(targetDots / qrModules(text))
  return Math.min(10, Math.max(1, cell))
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

export interface TsplOptions {
  /** How many of this label to print. The job's own `copies`. */
  copies?: number
  /** 0 to 15. Eight is the T003's own default on direct thermal stock. */
  density?: number
}

/**
 * One label as TSPL2, line by line.
 *
 * The sleeve is a centred column, QR over code, because 25 x 15 mm has no
 * room for anything beside the symbol. Every other label is the QR on the
 * left and a block of lines centred beside it, which is the print page's
 * layout in dots.
 */
export function tsplCommands(layout: LabelLayout, options: TsplOptions = {}): string[] {
  const copies = Math.max(1, Math.round(options.copies ?? 1))
  const density = Math.min(15, Math.max(0, Math.round(options.density ?? 8)))
  const { spec } = layout

  const width = spec.widthPx
  const height = spec.heightPx
  const padding = dots(PADDING_MM)
  const gap = dots(GAP_MM)
  const lineGap = dots(LINE_GAP_MM)

  const out: string[] = [
    `SIZE ${mm(spec.widthMm)} mm,${mm(spec.heightMm)} mm`,
    "GAP 2 mm,0 mm",
    `DENSITY ${density}`,
    "CODEPAGE 850",
    "CLS",
  ]

  const cell = qrCell(layout.qrText, spec.qrPx)
  const qrSize = qrModules(layout.qrText) * cell

  /** A line of text, already measured, as one TEXT command. */
  const text = (x: number, y: number, choice: FontChoice, content: string) =>
    `TEXT ${x},${y},"${choice.font.name}",0,${choice.multiplier},${choice.multiplier},"${escapeTspl(content)}"`

  if (layout.template === "sleeve_25x15") {
    const choice = fitFont(dots(layout.metaMm))
    const code = layout.lines[0]?.text ?? ""
    const codeWidth = code.length * choice.width
    const total = qrSize + lineGap + choice.height
    const top = Math.max(0, Math.round((height - total) / 2))
    out.push(
      `QRCODE ${Math.round((width - qrSize) / 2)},${top},L,${cell},A,0,"${escapeTspl(layout.qrText)}"`
    )
    out.push(
      text(
        Math.max(0, Math.round((width - codeWidth) / 2)),
        top + qrSize + lineGap,
        choice,
        code
      )
    )
    out.push(`PRINT 1,${copies}`)
    return out
  }

  const qrTop = Math.max(0, Math.round((height - qrSize) / 2))
  out.push(`QRCODE ${padding},${qrTop},L,${cell},A,0,"${escapeTspl(layout.qrText)}"`)

  const columnLeft = padding + qrSize + gap
  const columnWidth = Math.max(8, width - columnLeft - padding)

  const sized = layout.lines.map((line) => ({
    line,
    choice: fitFont(dots(sizeMmFor(layout, line))),
  }))
  const blockHeight =
    sized.reduce((total, row) => total + row.choice.height, 0) +
    lineGap * Math.max(0, sized.length - 1)

  let y = Math.max(0, Math.round((height - blockHeight) / 2))
  for (const row of sized) {
    out.push(
      text(columnLeft, y, row.choice, fitText(row.line.text, row.choice.width, columnWidth))
    )
    y += row.choice.height + lineGap
  }

  // The G mark is a drawn shape, so the thermal label carries the two
  // letters it stands for instead, in the smallest font, in the corner the
  // print page puts the mark in.
  if (layout.showMark) {
    const mark = TSPL_FONTS[0]
    out.push(
      `TEXT ${width - padding - mark.width * 2},${height - padding - mark.height},"${mark.name}",0,1,1,"GG"`
    )
  }

  out.push(`PRINT 1,${copies}`)
  return out
}

/** Which of the layout's three type sizes a line is set in. */
function sizeMmFor(layout: LabelLayout, line: LabelLine): number {
  if (line.role === "title") return layout.titleMm
  if (line.role === "price") return layout.priceMm
  return layout.metaMm
}

/** The commands as the printer reads them: CRLF terminated, one per line. */
export function tsplLabel(layout: LabelLayout, options: TsplOptions = {}): string {
  return `${tsplCommands(layout, options).join("\r\n")}\r\n`
}

/**
 * The bytes to send.
 *
 * One byte per character: ASCII as it is, the pound sign as CP850's 0x9C.
 * `toPrintable` has already taken everything else out, so nothing here can
 * silently become a different glyph on the label.
 */
export function tsplBytes(layout: LabelLayout, options: TsplOptions = {}): Uint8Array {
  return encodeTspl(tsplLabel(layout, options))
}

export function encodeTspl(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 0x00a3) {
      bytes[index] = POUND_BYTE
      continue
    }
    // `toPrintable` has already been over every argument, so anything left
    // above ASCII came from a caller that built its own line: it goes out as
    // a question mark rather than as a byte the printer reads as a command.
    bytes[index] = code < 0x80 ? code : 0x3f
  }
  return bytes
}
