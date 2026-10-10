/**
 * Item photos: cropped to the item's frame, downscaled and stripped before
 * they leave the counter (docs/api-contract-launch.md, section 6).
 *
 * The frame is the platform ratio every picture of the item is shown in
 * (`src/design/platforms.ts`), so a photographed cartridge sits in the
 * website's grid, the stock list and the item page as neatly as a catalogue
 * image. The capture guide is that frame drawn over the webcam, a little
 * inside the picture so the edges show what is being cut; what is inside the
 * guide is exactly what is kept. A photo taken with the tablet's own camera
 * app, or chosen from a file, never saw the guide, so it keeps the largest
 * frame that fits, centred.
 *
 * Downscaled to 1600px on the long edge and re-encoded as JPEG in one draw,
 * which also drops the EXIF block (location, camera serial) the device
 * wrote: only pixels are kept. The same rule as the ID photo
 * (`features/tradein/id-photo.ts`), whose decoder and size cap are reused.
 *
 * Everything the browser supplies is injected, so the maths is tested in
 * jsdom, which has no decoder and no canvas.
 */
import {
  browserDeps,
  dataUrlToBlob,
  fitWithin,
  JPEG_QUALITY,
  MAX_EDGE,
  type DownscaleDeps,
  type DownscaleResult,
  type Size,
} from "@/features/tradein/id-photo"

export { MAX_EDGE }
export type { Size }

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** A frame ratio as `[width, height]`, in the ratio's own units. */
export type Ratio = readonly [number, number]

/** How much of the picture the webcam's guide covers, centred. */
export const GUIDE_SCALE = 0.86

/**
 * The largest rectangle of `ratio` that fits inside `source`, centred, then
 * scaled by `scale` about its centre. Whole pixels, never outside the source
 * and never smaller than one pixel a side.
 */
export function centredCrop(source: Size, ratio: Ratio, scale = 1): Rect {
  const [rw, rh] = ratio
  if (!(source.width > 0) || !(source.height > 0) || !(rw > 0) || !(rh > 0)) {
    return { x: 0, y: 0, width: Math.max(0, Math.round(source.width)), height: Math.max(0, Math.round(source.height)) }
  }
  const factor = Math.min(1, Math.max(0.05, scale))
  const target = rw / rh
  let width = source.width
  let height = width / target
  if (height > source.height) {
    height = source.height
    width = height * target
  }
  width = Math.max(1, Math.min(source.width, Math.round(width * factor)))
  height = Math.max(1, Math.min(source.height, Math.round(height * factor)))
  return {
    x: Math.round((source.width - width) / 2),
    y: Math.round((source.height - height) / 2),
    width,
    height,
  }
}

/**
 * Where the guide sits over a picture drawn at `shown` size, as fractions of
 * that box (0 to 1), so the overlay can be laid out in CSS percentages over
 * the live video whatever size the sheet makes it.
 */
export function guideBox(source: Size, ratio: Ratio, scale = GUIDE_SCALE): Rect {
  const crop = centredCrop(source, ratio, scale)
  if (!(source.width > 0) || !(source.height > 0)) return { x: 0, y: 0, width: 1, height: 1 }
  return {
    x: crop.x / source.width,
    y: crop.y / source.height,
    width: crop.width / source.width,
    height: crop.height / source.height,
  }
}

/** The size the kept part is written at: 1600px on the long edge at most, never blown up. */
export function outputSize(crop: Size, maxEdge: number = MAX_EDGE): Size {
  return fitWithin(crop, maxEdge)
}

export interface CropOptions {
  ratio: Ratio
  /** 1 for a file or the tablet's camera app; `GUIDE_SCALE` for the webcam. */
  scale?: number
  maxEdge?: number
  quality?: number
  deps?: DownscaleDeps
}

/**
 * Crop a picture to the frame, downscale it and re-encode it as JPEG. Takes a
 * file or blob (decoded here, EXIF orientation applied by the browser's own
 * decoder) or a picture already decoded (a webcam frame).
 */
export async function cropToFrame(
  input: Blob | { source: CanvasImageSource; width: number; height: number },
  options: CropOptions
): Promise<DownscaleResult> {
  const deps = options.deps ?? browserDeps
  const quality = options.quality ?? JPEG_QUALITY
  const image =
    input instanceof Blob
      ? await deps.decode(input)
      : { source: input.source, width: input.width, height: input.height, release: undefined }

  const crop = centredCrop({ width: image.width, height: image.height }, options.ratio, options.scale ?? 1)
  const size = outputSize(crop, options.maxEdge ?? MAX_EDGE)
  if (size.width === 0 || size.height === 0) {
    image.release?.()
    throw new Error("That photo has no picture in it. Take it again.")
  }

  const canvas = deps.createCanvas(size)
  const context = canvas.getContext("2d")
  if (!context) {
    image.release?.()
    throw new Error("This device cannot resize the photo. Try another device.")
  }
  context.drawImage(image.source, crop.x, crop.y, crop.width, crop.height, 0, 0, size.width, size.height)
  image.release?.()

  const dataUrl = canvas.toDataURL("image/jpeg", quality)
  const blob = await new Promise<Blob | null>((resolve) => {
    if (typeof canvas.toBlob === "function") {
      canvas.toBlob(resolve, "image/jpeg", quality)
    } else {
      resolve(dataUrlToBlob(dataUrl))
    }
  })
  if (!blob) throw new Error("That photo could not be saved. Take it again.")
  return { blob, dataUrl, width: size.width, height: size.height }
}

/** A JPEG file name that says what it is, for the upload. */
export function itemPhotoName(sku: string, now: Date = new Date()): string {
  const safe = sku.replace(/[^A-Za-z0-9]/g, "").toLowerCase() || "item"
  return `${safe}-${now.toISOString().slice(0, 10)}.jpg`
}
