/**
 * Handing a buy-in offer to the customer on the display, as a state.
 *
 * The buy-in wizard publishes the offer, the tablet accepts it, and the
 * signature is only taken once one of those has happened or the counter has
 * said the customer is accepting it verbally instead. Pure, so the sentence
 * on screen and the gate on the button can never drift apart.
 */

/** Where the offer has got to on the customer-facing screen. */
export type DisplayHandoff = "off" | "idle" | "waiting" | "accepted" | "skipped"

/** The handoff is done with, so the customer can sign. */
export function handoffSettled(handoff: DisplayHandoff): boolean {
  return handoff === "off" || handoff === "accepted" || handoff === "skipped"
}

/** The line under the two display actions, for each state it can be in. */
export function handoffSentence(handoff: DisplayHandoff): string {
  switch (handoff) {
    case "waiting":
      return "On the display now. It is signed here once the customer accepts it."
    case "accepted":
      return "Accepted on the display. Take their signature below."
    case "skipped":
      return "Taken verbally. Take their signature below."
    default:
      return "Send the offer to the screen facing the customer, and they accept it there."
  }
}
