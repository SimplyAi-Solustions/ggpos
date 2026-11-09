/**
 * The phone camera for card photos: open the rear camera, sample the part of
 * each preview frame inside the card guide for the capture checks, and cut a
 * full-resolution crop of that same region to send for identification.
 *
 * Adapted from apps/web/src/lib/scanning/camera.ts (the barcode scanner),
 * without the barcode decoding.
 */

export interface Size {
  width: number
  height: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The long edge sent to the model. The bake-off resized every photo to 1,400 px. */
export const SEND_LONG_EDGE = 1400
/** The width the per-frame checks run at (capture-quality.ts says about 160 px). */
export const CHECK_WIDTH = 160

export function hasCamera(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function"
}

/**
 * Where an on-screen rectangle (the card guide) falls on the video's own
 * pixels, when the video fills its box with `object-fit: cover`.
 */
export function coverCrop(video: Size, box: Size, guide: Rect): Rect {
  const scale = Math.max(box.width / video.width, box.height / video.height)
  const shownW = video.width * scale
  const shownH = video.height * scale
  const offsetX = (box.width - shownW) / 2
  const offsetY = (box.height - shownH) / 2
  const x = Math.max(0, (guide.x - offsetX) / scale)
  const y = Math.max(0, (guide.y - offsetY) / scale)
  return {
    x,
    y,
    width: Math.min(video.width - x, guide.width / scale),
    height: Math.min(video.height - y, guide.height / scale),
  }
}

/** Fit a size inside a long edge, never upscaling. */
export function fitLongEdge(size: Size, longEdge: number): Size {
  const scale = Math.min(1, longEdge / Math.max(size.width, size.height))
  return { width: Math.round(size.width * scale), height: Math.round(size.height * scale) }
}

export interface CameraHandle {
  stream: MediaStream
  stop(): void
  torchAvailable(): boolean
  setTorch(on: boolean): Promise<boolean>
}

type TorchCapable = MediaTrackCapabilities & { torch?: boolean }

export async function openCamera(video: HTMLVideoElement, signal?: AbortSignal): Promise<CameraHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  })
  if (signal?.aborted) {
    stream.getTracks().forEach((t) => t.stop())
    throw new DOMException("Camera closed before it opened", "AbortError")
  }
  video.srcObject = stream
  video.setAttribute("playsinline", "true")
  await video.play().catch(() => undefined)
  const track = () => stream.getVideoTracks()[0] ?? null
  return {
    stream,
    stop() {
      stream.getTracks().forEach((t) => t.stop())
      // Only clear the element if it still shows this stream: a newer one
      // (React's double effect in development) may already be attached.
      if (video.srcObject === stream) video.srcObject = null
    },
    torchAvailable() {
      const caps = track()?.getCapabilities?.() as TorchCapable | undefined
      return caps?.torch === true
    },
    async setTorch(on: boolean) {
      const t = track()
      if (!t) return false
      try {
        await t.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] })
        return on
      } catch {
        return false
      }
    },
  }
}

/** Draws a region of a source into a new canvas of the given size. */
export function cropToCanvas(source: CanvasImageSource, region: Rect, out: Size): HTMLCanvasElement {
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, out.width)
  canvas.height = Math.max(1, out.height)
  const ctx = canvas.getContext("2d")
  ctx?.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height)
  return canvas
}

/** A canvas as the base64 JPEG the identify route takes. */
export function canvasToJpeg(canvas: HTMLCanvasElement, quality = 0.85): string {
  return canvas.toDataURL("image/jpeg", quality)
}

/** A picked file (camera roll or desktop upload) as a JPEG data URL at the send size. */
export async function fileToJpeg(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const out = fitLongEdge({ width: bitmap.width, height: bitmap.height }, SEND_LONG_EDGE)
  const canvas = cropToCanvas(bitmap, { x: 0, y: 0, width: bitmap.width, height: bitmap.height }, out)
  bitmap.close?.()
  return canvasToJpeg(canvas)
}
