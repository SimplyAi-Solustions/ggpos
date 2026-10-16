/**
 * PocketBase serves fixed-width WebP thumbs from `?thumb=WxH`. A height of 0
 * keeps the source ratio, which is what every product image wants.
 *
 * Only PocketBase file URLs (`/api/files/{collection}/{record}/{file}`) are
 * touched; anything else - Scryfall, TCGdex, IGDB - is returned untouched,
 * because rewriting a third party URL would just break it.
 */

const POCKETBASE_FILE_PATH = "/api/files/"

/** Widths PocketBase is configured to generate. */
export const THUMB_WIDTHS = [160, 320, 640] as const
export type ThumbWidth = (typeof THUMB_WIDTHS)[number]

export function isPocketBaseFileUrl(url: string): boolean {
  return url.includes(POCKETBASE_FILE_PATH)
}

export function thumbUrl(fileUrl: string, width: number): string {
  if (!fileUrl || !isPocketBaseFileUrl(fileUrl)) return fileUrl
  if (/[?&]thumb=/.test(fileUrl)) return fileUrl
  const separator = fileUrl.includes("?") ? "&" : "?"
  return `${fileUrl}${separator}thumb=${Math.round(width)}x0`
}

/** Picks the smallest generated width that still covers the frame at 2x. */
export function bestThumbWidth(frameWidth: number): ThumbWidth {
  const wanted = frameWidth * 2
  return THUMB_WIDTHS.find((w) => w >= wanted) ?? THUMB_WIDTHS[THUMB_WIDTHS.length - 1]
}

/** `srcset` across the generated widths, for PocketBase files only. */
export function thumbSrcSet(fileUrl: string): string | undefined {
  if (!isPocketBaseFileUrl(fileUrl)) return undefined
  return THUMB_WIDTHS.map((w) => `${thumbUrl(fileUrl, w)} ${w}w`).join(", ")
}
