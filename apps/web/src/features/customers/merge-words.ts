/**
 * What a merge moved, in one line the counter can read out.
 *
 * Apart from the screen so the sentence can be unit tested: the server
 * returns a count per collection, and a row of raw table names is not
 * something to put in front of a customer.
 */

const MOVED_LABEL: Record<string, string> = {
  trade_ins: "trade-in",
  sales: "sale",
  quotes: "quote",
  credit_ledger: "credit entry",
  points_ledger: "points entry",
  want_list: "want list row",
}

/** "Moved 3 trade-ins and 1 credit entry." Nothing at zero is listed. */
export function movedSentence(moved: Record<string, number>): string {
  const parts = Object.entries(moved)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => {
      const word = MOVED_LABEL[key] ?? key.replace(/_/g, " ")
      return `${count} ${word}${count === 1 ? "" : "s"}`
    })
  if (parts.length === 0) return "The two cards are now one. There was nothing to move."
  if (parts.length === 1) return `Moved ${parts[0]}.`
  const last = parts[parts.length - 1]
  return `Moved ${parts.slice(0, -1).join(", ")} and ${last}.`
}
