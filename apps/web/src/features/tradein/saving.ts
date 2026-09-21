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

/**
 * Whether completing has to write the lines first.
 *
 * Unlike `needsSave` this ignores whether a write is in flight: the
 * completion awaits its own write either way, so the server prices the
 * lines the counter is looking at rather than the ones from before the
 * payout tile was switched.
 */
export function needsFlush(shape: string, savedShape: string): boolean {
  return shape !== savedShape
}
