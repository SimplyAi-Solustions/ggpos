/**
 * The signature pad's maths, kept out of the component so it can be tested
 * without a canvas that draws.
 *
 * A signature is legal evidence on a second-hand purchase, so the rules are
 * deliberately plain: a pad with no ink exports nothing, and what is exported
 * is a PNG data URL at the pad's own pixel size, which is what the completion
 * route stores and the receipt prints.
 */

/** The minimum canvas the pad will accept, to stop a zero-size export. */
export const MIN_PAD_WIDTH = 120
export const MIN_PAD_HEIGHT = 60

export interface SignatureCanvas {
  width: number
  height: number
  toDataURL: (type?: string) => string
}

/**
 * The PNG for a signed pad, or null when nothing has been drawn on it.
 * `hasInk` is tracked by the pad itself: reading pixels back would need a
 * context the test environment does not have, and a same-origin canvas is
 * not worth the round trip on a phone.
 */
export function exportSignature(
  canvas: SignatureCanvas | null,
  hasInk: boolean
): string | null {
  if (!canvas || !hasInk) return null
  if (canvas.width < MIN_PAD_WIDTH || canvas.height < MIN_PAD_HEIGHT) return null
  const url = canvas.toDataURL("image/png")
  return url && url.startsWith("data:image/png") ? url : null
}

export interface Point {
  x: number
  y: number
}

/**
 * Where a pointer is on the pad, in canvas pixels rather than CSS pixels, so
 * a retina pad draws where the finger is rather than at a quarter scale.
 */
export function pointIn(
  rect: { left: number; top: number; width: number; height: number },
  canvas: { width: number; height: number },
  event: { clientX: number; clientY: number }
): Point {
  const scaleX = rect.width > 0 ? canvas.width / rect.width : 1
  const scaleY = rect.height > 0 ? canvas.height / rect.height : 1
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
  }
}

/** Two points close enough together that the stroke should ignore the move. */
export function isSamePoint(a: Point, b: Point, tolerance = 0.5): boolean {
  return Math.abs(a.x - b.x) < tolerance && Math.abs(a.y - b.y) < tolerance
}
