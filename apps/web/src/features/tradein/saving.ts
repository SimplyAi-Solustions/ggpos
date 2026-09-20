/**
 * When the buy-in wizard writes its lines, and what it remembers writing.
 *
 * Apart from the screen because getting it wrong loses a line rather than
 * looking wrong: a shape remembered before the request means the next change
 * compares equal to one that was never written, and the counter's offer and
 * the server's differ from then on. So a shape is remembered only once the
 * server has it, and a refusal forgets it so the same lines are written
 * again.
 */

/** Never equal to a real shape, so a failed save is always retried. */
export const UNSAVED = "\u0000unsaved"

/** Whether the debounce should schedule a write. */
export function needsSave(
  shape: string,
  savedShape: string,
  inFlight: boolean
): boolean {
  if (inFlight) return false
  return shape !== savedShape
}

/** What to remember after a write finishes, either way. */
export function nextSavedShape(
  outcome: "saved" | "failed",
  shape: string
): string {
  return outcome === "saved" ? shape : UNSAVED
}
