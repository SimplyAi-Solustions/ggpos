/**
 * The Epos Now till link as one sentence for The Counter (Phase 8). Pure, so
 * the wording is tested on its own.
 */
import type { EposLink } from "@/lib/api/types"

/** The till line in words, never in a colour. */
export function eposLinkSentence(link: EposLink): string {
  if (link.status === "linked" || link.eposCustomerId) {
    return `On the till as Epos Now customer ${link.eposCustomerId}.`
  }
  if (link.status === "in_progress") {
    return "Being added to the till now. Check again in a minute."
  }
  if (link.status === "queued") {
    return link.attempts > 0
      ? `Not on the till yet. Epos Now did not answer, so it tries again every five minutes (${link.attempts} ${link.attempts === 1 ? "try" : "tries"} so far).`
      : "Waiting to be added to the till."
  }
  if (link.status === "failed") {
    return `Epos Now refused the link after ${link.attempts} tries. ${link.error} Check the Epos Now API token, then link again.`.replace(
      /\s+/g,
      " "
    )
  }
  return "Not on the till. Their card will not scan at Epos Now until they are linked."
}
