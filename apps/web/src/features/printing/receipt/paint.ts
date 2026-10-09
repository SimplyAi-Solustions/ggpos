/**
 * The thin canvas painter: turns a `Layout` (a list of positioned draw
 * operations, see `draw.ts`) into a PNG the printer prints pixel for pixel.
 *
 * Everything that decides where things go is in the layout. What is left
 * here is the part only a browser can do: wait for the app's own fonts,
 * measure text with them, draw it, draw the barcode and the QR with bwip-js,
 * and push every pixel to pure black or pure white. A thermal printer has
 * one colour, and a one-bit image is what its `X-Star-ImageDitherPattern:
 * none` header promises it will get, so the antialiasing the canvas puts on
 * the edge of a letter is thresholded away here rather than dithered into
 * speckle on the paper.
 *
 * The canvas is never attached to the page and is exactly the paper's width
 * in pixels: no device pixel ratio, no CSS size, no scaling.
 */
import { toCanvas, type RenderOptions } from "bwip-js/browser"

import { fontString, type DrawOp, type FontSpec, type Layout, type Measure, type QrOp, type BarcodeOp } from "./draw"

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
  '400 24px "Jost Variable"',
  '500 24px "Jost Variable"',
] as const

/** Characters a receipt can always need, loaded alongside whatever the data has. */
const ALWAYS = ` ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789£€×·'’"()-+,.:;/&%#@!?*`

/**
 * Wait for Anton, Space Mono and Jost to be ready for `text`. The fonts are
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
 * small Jost still print.
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

/** bwip-js draws in points (1/72 in): this turns dots of bar height into its millimetres. */
function barHeightMm(dots: number, scale: number): number {
  return (dots / scale) * (25.4 / 72)
}

/**
 * Draw a bwip-js symbol at the largest whole-number scale that fits `room`
 * dots across. Whole numbers matter: a bar that is 2.4 dots wide prints as
 * a mix of 2 and 3 and a scanner will not read it.
 */
function symbol(options: RenderOptions, room: number, limit: number): HTMLCanvasElement | null {
  try {
    const probe = document.createElement("canvas")
    toCanvas(probe, { ...options, scale: 1 })
    const scale = Math.max(1, Math.min(limit, Math.floor(room / Math.max(1, probe.width))))
    const canvas = document.createElement("canvas")
    const sized: RenderOptions = { ...options, scale }
    // `height` is in millimetres at one point a dot; this keeps the bars
    // `options.height` dots tall at whatever scale was chosen. It is only
    // set when asked for: an explicit undefined makes bwip-js refuse a QR.
    if (options.height !== undefined) sized.height = barHeightMm(options.height, scale)
    toCanvas(canvas, sized)
    return canvas
  } catch (error) {
    // A value the symbology cannot carry is not worth losing the receipt
    // for, but it should not vanish without a word either.
    console.warn(`The ${String(options.bcid)} on the receipt could not be drawn:`, error)
    return null
  }
}

function drawBarcode(ctx: Context, op: BarcodeOp) {
  const canvas = symbol(
    {
      bcid: "code128",
      text: op.value,
      height: op.height,
      includetext: false,
      paddingwidth: 0,
      paddingheight: 0,
    },
    op.width,
    4
  )
  if (!canvas) return
  ctx.drawImage(canvas, Math.round(op.x + (op.width - canvas.width) / 2), op.y)
}

function drawQr(ctx: Context, op: QrOp) {
  const canvas = symbol(
    { bcid: "qrcode", text: op.value, paddingwidth: 0, paddingheight: 0 },
    op.size,
    8
  )
  if (!canvas) return
  ctx.drawImage(
    canvas,
    Math.round(op.x + (op.size - canvas.width) / 2),
    Math.round(op.y + (op.size - canvas.height) / 2)
  )
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
      drawQr(ctx, op)
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
