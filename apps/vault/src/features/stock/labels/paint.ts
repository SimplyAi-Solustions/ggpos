/**
 * The thin canvas painter: turns a `Layout` (a list of positioned draw
 * operations, see `draw.ts`) into a PNG the printer prints pixel for pixel.
 *
 * Everything that decides where things go is in the layout. What is left
 * here is the part only a browser can do: wait for the app's own fonts,
 * measure text with them, draw it,
 * and push every pixel to pure black or pure white. A thermal printer has
 * one colour, and a one-bit image is what its `X-Star-ImageDitherPattern:
 * none` header promises it will get, so the antialiasing the canvas puts on
 * the edge of a letter is thresholded away here rather than dithered into
 * speckle on the paper.
 *
 * The canvas is never attached to the page and is exactly the paper's width
 * in pixels: no device pixel ratio, no CSS size, no scaling.
 */
import { LOGO } from "@/brand/logo-paths"

import { code128Modules } from "./code128"
import {
  type BarcodeOp,
  fontString,
  type DrawOp,
  type FontSpec,
  type Layout,
  type LogoOp,
  type Measure,
} from "./draw"

/**
 * The faces a receipt uses, one entry per weight. `document.fonts.load`
 * resolves once the browser has fetched the file for that face, which a
 * canvas will not wait for on its own: a canvas that draws before the font
 * arrives silently falls back to a system sans.
 */
const FACES = [
  '400 32px "Anton"',
  '400 24px "Space Mono"',
  '700 24px "Space Mono"',
  '400 24px "Poppins"',
  '500 24px "Poppins"',
  '600 24px "Poppins"',
] as const

/** Characters a receipt can always need, loaded alongside whatever the data has. */
const ALWAYS = ` ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789£€×·'’"()-+,.:;/&%#@!?*`

/**
 * Wait for Anton, Space Mono and Poppins to be ready for `text`. The fonts are
 * split by unicode range, so the load names the characters that will be
 * drawn: that is what pulls in the right file.
 */
export async function loadFonts(text: string): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return
  const sample = `${ALWAYS}${text}`
  await Promise.all(
    FACES.map((face) =>
      document.fonts.load(face, sample).catch(() => [] as FontFace[])
    )
  )
}

type Context = CanvasRenderingContext2D

function setTracking(ctx: Context, tracking: number | undefined) {
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${tracking ?? 0}px`
}

function applyFont(ctx: Context, font: FontSpec) {
  ctx.font = fontString(font)
  setTracking(ctx, font.tracking)
}

function newContext(canvas: HTMLCanvasElement, readBack = false): Context {
  const ctx = canvas.getContext("2d", readBack ? { willReadFrequently: true } : undefined)
  if (!ctx) throw new Error("This browser cannot draw the receipt. Open GG Vault in Chrome.")
  return ctx
}

/** A `Measure` backed by the browser's own text metrics. */
export function canvasMeasure(): Measure {
  const ctx = newContext(document.createElement("canvas"))
  return (text, font) => {
    applyFont(ctx, font)
    return ctx.measureText(text).width
  }
}

/**
 * Push every pixel to black or white, in place. A pixel darker than `cutoff`
 * (a luminance out of 255) is ink; anything lighter, and anything see-through,
 * is paper. The cutoff sits a little above half so the thin strokes of a
 * small Poppins still print.
 */
export function thresholdPixels(data: Uint8ClampedArray, cutoff = 160): void {
  for (let i = 0; i < data.length; i += 4) {
    const alpha = (data[i + 3] ?? 255) / 255
    const luma = 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0)
    // Over white paper: a see-through pixel is white.
    const shown = luma * alpha + 255 * (1 - alpha)
    const value = shown < cutoff ? 0 : 255
    data[i] = value
    data[i + 1] = value
    data[i + 2] = value
    data[i + 3] = 255
  }
}

/** Both Gs in ink, no outline: the lockup as `GGLogo mono` draws it. */
function drawLogo(ctx: Context, op: LogoOp) {
  const scale = op.height / Number(LOGO.viewBox.split(" ")[3] ?? 100)
  ctx.save()
  ctx.translate(op.x, op.y)
  ctx.scale(scale, scale)
  ctx.fill(new Path2D(LOGO.paper))
  ctx.fill(new Path2D(LOGO.volt))
  ctx.restore()
}

/**
 * Whole-dot bars, one fillRect per run of bar modules, at integer
 * positions: the canvas has nothing to smooth, so every edge lands on a dot.
 */
export function barcodeRects(op: BarcodeOp): { x: number; width: number }[] {
  const module = Math.max(1, Math.floor(op.module ?? 1))
  const modules = code128Modules(op.value)
  const rects: { x: number; width: number }[] = []
  let i = 0
  while (i < modules.length) {
    if (!modules[i]) {
      i++
      continue
    }
    let j = i
    while (j < modules.length && modules[j]) j++
    rects.push({ x: Math.round(op.x) + i * module, width: (j - i) * module })
    i = j
  }
  return rects
}

function drawBarcode(ctx: Context, op: BarcodeOp) {
  for (const rect of barcodeRects(op)) ctx.fillRect(rect.x, Math.round(op.y), rect.width, Math.round(op.height))
}

function drawOp(ctx: Context, op: DrawOp) {
  switch (op.kind) {
    case "text":
      applyFont(ctx, op.font)
      ctx.textAlign = op.align
      ctx.textBaseline = "alphabetic"
      ctx.fillText(op.text, op.x, op.y)
      return
    case "rule":
      if (!op.dashed) {
        ctx.fillRect(op.x, op.y, op.width, op.thickness)
        return
      }
      for (let x = op.x; x < op.x + op.width; x += 14) {
        ctx.fillRect(x, op.y, Math.min(8, op.x + op.width - x), op.thickness)
      }
      return
    case "barcode":
      drawBarcode(ctx, op)
      return
    case "qr":
      // Price labels carry none; the counter's TSPL labels do.
      return
    case "logo":
      drawLogo(ctx, op)
      return
  }
}

/** Paint a layout onto a fresh canvas: white paper, black ink, one bit. */
export function paintLayout(layout: Layout): HTMLCanvasElement {
  const canvas = document.createElement("canvas")
  canvas.width = layout.width
  canvas.height = layout.height
  const ctx = newContext(canvas, true)
  ctx.fillStyle = "#ffffff"
  ctx.fillRect(0, 0, layout.width, layout.height)
  ctx.fillStyle = "#000000"
  ctx.textRendering = "geometricPrecision"
  ctx.imageSmoothingEnabled = false
  for (const op of layout.ops) drawOp(ctx, op)

  const image = ctx.getImageData(0, 0, layout.width, layout.height)
  thresholdPixels(image.data)
  ctx.putImageData(image, 0, 0)
  return canvas
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error("The receipt could not be turned into an image. Try again."))
    }, "image/png")
  })
}

/**
 * The whole job: wait for the fonts, lay the page out with the browser's own
 * measurements, paint it, and hand back the PNG. `text` is everything the
 * page will say, so the right font files are fetched before anything is
 * measured.
 */
export async function drawToBlob(
  text: string,
  build: (measure: Measure) => Layout
): Promise<Blob> {
  await loadFonts(text)
  return canvasToBlob(paintLayout(build(canvasMeasure())))
}
