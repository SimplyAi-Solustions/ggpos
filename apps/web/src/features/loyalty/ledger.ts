/**
 * What a points row means, in one sentence.
 *
 * The portal's own `/me/points` route writes these server-side; the counter
 * composes them here from the row it reads, so the history on a customer's
 * profile and the history in My Vault say the same thing about the same row.
 */
import { formatGBP } from "@gg/shared"

import type { PointsLedgerRow } from "@/lib/api/types"

export const POINTS_REASON_LABEL: Record<string, string> = {
  earn_sale: "Sale",
  earn_trade_in: "Trade-in",
  rule_bonus: "Bonus",
  welcome: "Welcome",
  referral: "Referral",
  redeem: "Redeemed",
  adjust: "Adjusted",
  expire: "Expired",
  refund_reverse: "Refund",
}

export interface NoteContext {
  /** The sale or trade-in total the row was earned on, in pence. */
  amount?: number
  /** What a redemption bought. */
  rewardName?: string
  /** The programme's inactivity window, for an expiry row. */
  expiryMonths?: number
}

/** The sentence under a row in the points history. */
export function pointsNote(
  row: Pick<PointsLedgerRow, "reason" | "note">,
  context: NoteContext = {}
): string {
  if (row.note) return row.note
  switch (row.reason) {
    case "earn_sale":
      return context.amount !== undefined
        ? `Earned on a ${formatGBP(context.amount)} sale`
        : "Earned on a sale"
    case "earn_trade_in":
      return context.amount !== undefined
        ? `Earned on ${formatGBP(context.amount)} of trade-in credit`
        : "Earned on a trade-in"
    case "rule_bonus":
      return "Bonus from a Guild rule"
    case "welcome":
      return "Welcome bonus"
    case "referral":
      return "Referral bonus"
    case "redeem":
      return context.rewardName
        ? `Redeemed for ${context.rewardName}`
        : "Redeemed for a reward"
    case "expire":
      return context.expiryMonths
        ? `Expired after ${context.expiryMonths} months without a purchase`
        : "Expired after a long gap"
    case "adjust":
      return "Adjusted by the shop"
    case "refund_reverse":
      return "Reversed by a refund"
    default:
      return "Points moved"
  }
}
