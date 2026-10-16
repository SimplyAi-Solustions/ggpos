import { downscaleToJpeg, type DownscaleDeps } from "@/features/tradein/id-photo"

/**
 * Photos for a quote, downscaled and stripped before they leave the phone.
 *
 * Same rule as the ID photo at the counter, and the same operation behind it:
 * the picture is decoded, drawn into a canvas at no more than 1600px on the
 * long edge and re-encoded as JPEG, which keeps the pixels and drops
 * everything else the camera wrote, the GPS tag first among them. A customer
 * photographing a card on their kitchen table should not be sending us their
 * address with it.
 *
 * The canvas work is reused from `features/tradein/id-photo.ts` rather than
 * written twice; this module is the multi-photo half: the cap, the type
 * check, the ordering and the sentence to show when one will not open.
 */

export const MAX_PHOTOS = 20
export const MAX_EDGE = 1600
/** The route sniffs the type; this is the same list, checked before upload. */
export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"] as const
/** 10 MB each, refused here so a phone does not spend a minute uploading it. */
export const MAX_BYTES = 10 * 1024 * 1024

export interface PreparedPhoto {
  /** Stable across re-renders, so React keys and removal both work. */
  id: string
  blob: Blob
  /** A data URL for the thumbnail on screen. Never uploaded. */
  preview: string
  width: number
  height: number
}

export interface PrepareResult {
  photos: PreparedPhoto[]
  /** One sentence per file that could not be used, in the order they came. */
  rejected: string[]
}

function looksLikeImage(file: File): boolean {
  return (ACCEPTED_TYPES as readonly string[]).includes(file.type)
}

let counter = 0
function nextId(): string {
  counter += 1
  return `photo-${counter}`
}

/**
 * Turn what the file picker handed over into upload-ready JPEGs.
 *
 * `existing` is how many are already on the form, so the cap counts the whole
 * set rather than one pick at a time. Anything refused comes back as a
 * sentence naming the file and what to do about it.
 */
export async function preparePhotos(
  files: File[],
  existing = 0,
  options: { maxEdge?: number; deps?: DownscaleDeps } = {}
): Promise<PrepareResult> {
  const photos: PreparedPhoto[] = []
  const rejected: string[] = []
  let room = Math.max(0, MAX_PHOTOS - existing)

  for (const file of files) {
    if (room === 0) {
      rejected.push(
        `${file.name} was not added. ${MAX_PHOTOS} photos is the most we can take.`
      )
      continue
    }
    if (!looksLikeImage(file)) {
      rejected.push(`${file.name} is not a photo. Send a JPEG, a PNG or a WebP.`)
      continue
    }
    if (file.size > MAX_BYTES) {
      rejected.push(`${file.name} is too big. Each photo has to be under 10 MB.`)
      continue
    }
    try {
      const result = await downscaleToJpeg(file, {
        maxEdge: options.maxEdge ?? MAX_EDGE,
        deps: options.deps,
      })
      photos.push({
        id: nextId(),
        blob: result.blob,
        preview: result.dataUrl,
        width: result.width,
        height: result.height,
      })
      room -= 1
    } catch {
      rejected.push(`${file.name} could not be opened. Take it again.`)
    }
  }

  return { photos, rejected }
}

/** How many more photos this form will take. */
export function roomLeft(count: number): number {
  return Math.max(0, MAX_PHOTOS - count)
}
