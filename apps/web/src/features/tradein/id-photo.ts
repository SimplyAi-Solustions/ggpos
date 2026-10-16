/**
 * The ID photo, downscaled and stripped before it leaves the counter.
 *
 * `docs/PLAN.md` asks for a client-side downscale to 1600px on the long edge
 * and an EXIF strip. Both fall out of the same operation: drawing the photo
 * into a canvas and re-encoding it as JPEG keeps only the pixels, so the GPS
 * tag, the camera serial and the orientation flag the phone wrote never
 * reach the server.
 *
 * Everything the browser supplies (decoding an image, making a canvas) is
 * injected, so the rules above can be tested in jsdom, which has neither.
 */

export const MAX_EDGE = 1600
export const JPEG_QUALITY = 0.82

export interface Size {
  width: number
  height: number
}

/**
 * The size to draw at: the long edge capped at `maxEdge`, the aspect ratio
 * kept, and an image already smaller left exactly as it is rather than blown
 * up into a bigger, blurrier file.
 */
export function fitWithin(size: Size, maxEdge: number = MAX_EDGE): Size {
  const longest = Math.max(size.width, size.height)
  if (longest <= 0) return { width: 0, height: 0 }
  if (longest <= maxEdge) {
    return { width: Math.round(size.width), height: Math.round(size.height) }
  }
  const scale = maxEdge / longest
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  }
}

export interface DecodedImage extends Size {
  source: CanvasImageSource
  /** Called once the draw is done, so a bitmap can free its memory. */
  release?: () => void
}

export interface DownscaleDeps {
  decode: (file: Blob) => Promise<DecodedImage>
  createCanvas: (size: Size) => HTMLCanvasElement
}

export interface DownscaleResult {
  blob: Blob
  dataUrl: string
  width: number
  height: number
}

/** The browser's own decoder, preferring the one that does not need the DOM. */
async function decodeInBrowser(file: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file)
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () =>
        reject(new Error("That photo could not be read. Take it again."))
      element.src = url
    })
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

function createCanvasInBrowser(size: Size): HTMLCanvasElement {
  const canvas = document.createElement("canvas")
  canvas.width = size.width
  canvas.height = size.height
  return canvas
}

export const browserDeps: DownscaleDeps = {
  decode: decodeInBrowser,
  createCanvas: createCanvasInBrowser,
}

/**
 * Downscale a photo to `maxEdge` on the long edge and re-encode it as JPEG.
 * The returned data URL is only for the preview on screen; the blob is what
 * goes into the multipart form.
 */
export async function downscaleToJpeg(
  file: Blob,
  options: {
    maxEdge?: number
    quality?: number
    deps?: DownscaleDeps
  } = {}
): Promise<DownscaleResult> {
  const maxEdge = options.maxEdge ?? MAX_EDGE
  const quality = options.quality ?? JPEG_QUALITY
  const deps = options.deps ?? browserDeps

  const image = await deps.decode(file)
  const size = fitWithin({ width: image.width, height: image.height }, maxEdge)
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
  context.drawImage(image.source, 0, 0, size.width, size.height)
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

/** Last resort for a browser without `toBlob`, and the path tests take. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const [header = "", body = ""] = dataUrl.split(",")
  const mime = /:(.*?);/.exec(header)?.[1] ?? "image/jpeg"
  const binary = atob(body)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new Blob([bytes], { type: mime })
}

/** A JPEG file name that says what it is, for the multipart form. */
export function photoFileName(now: Date = new Date()): string {
  return `id-${now.toISOString().slice(0, 10)}.jpg`
}
