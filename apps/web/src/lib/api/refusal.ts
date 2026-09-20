import { ClientResponseError } from "pocketbase"

/**
 * A refusal the server wrote for staff to read.
 *
 * `docs/api-contract.md` is explicit that 409 (state conflict) and 422
 * (business rule: the ID gate, the cash cap, under 18) carry a `message`
 * written for the counter, and that 400 carries per-field messages. Those
 * belong under the control that caused them, never in a toast, so every
 * screen asks this module for the sentence rather than inventing one.
 *
 * Anything else (a dropped connection, a 500) has nothing staff-readable in
 * it, so `refusalMessage` returns null and the screen shows its own line.
 */

/**
 * Status codes whose `message` is written to be shown as-is. 502 is here
 * because a third-party lookup that does not answer is something staff can
 * act on ("IGDB did not answer. Try again, or add the title manually."),
 * unlike a 500, which never has staff-readable words in it.
 */
const SPOKEN = new Set([400, 403, 404, 409, 422, 502])

/** The server's own sentence for this failure, or null when it has none. */
export function refusalMessage(error: unknown): string | null {
  if (!(error instanceof ClientResponseError)) return null
  if (!SPOKEN.has(error.status)) return null

  const message = error.message?.trim()
  const fields = error.response?.data as
    | Record<string, { message?: string }>
    | undefined

  // A 400 from the collection API puts the useful part in `data`; the
  // top-level message is PocketBase's generic "Failed to create record."
  if (fields && typeof fields === "object") {
    const first = Object.values(fields).find((entry) => entry?.message)
    if (first?.message) return first.message
  }

  if (!message || /^\s*$/.test(message)) return null
  return message
}

/**
 * A refusal this app wrote for itself, rather than the server.
 *
 * Demo mode and a few guards raise a plain `Error` with a sentence already
 * written for the counter ("That password is not right. Try again."). Those
 * are worth showing as they are; a stack-trace-ish message from a library is
 * not, so only a message that ends like a sentence counts.
 */
function writtenMessage(error: unknown): string | null {
  if (error instanceof ClientResponseError) return null
  if (!(error instanceof Error)) return null
  const message = error.message?.trim()
  if (!message || message.length > 200) return null
  return /[.!?]$/.test(message) ? message : null
}

/**
 * The sentence to put under a control after a failed write: the server's
 * own words when it wrote any, this app's own when it wrote them instead,
 * and a plain fallback when neither did.
 */
export function refusalOrFallback(error: unknown, fallback: string): string {
  return refusalMessage(error) ?? writtenMessage(error) ?? fallback
}

/** True for the 404 a lookup makes when there is simply nothing there. */
export function isNotFound(error: unknown): boolean {
  return error instanceof ClientResponseError && error.status === 404
}
