/**
 * The UK sold comp form: what it accepts, and what it says when it does not.
 *
 * The three rules are the server's own (`pb_hooks/prices.pb.js`), in the
 * server's own words, so a staff member who mistypes a date hears about it
 * under the field instead of after a round trip. The route still checks
 * everything again: this is a courtesy, never the gate.
 */
import { parseDecimalToMinor } from "@gg/shared"

import type { UkCompInput } from "@/lib/api/types"

export interface CompFormValues {
  /** What was typed, in pounds. */
  price: string
  url: string
  /** YYYY-MM-DD, as the date input hands it over. */
  soldAt: string
}

export type CompErrors = Partial<Record<keyof CompFormValues, string>>

export const EBAY_ITEM_URL = /^https:\/\/(www\.)?ebay\.co\.uk\/itm\//i

/** The route's own ceiling, so a figure typed in pounds is caught here. */
export const MAX_COMP_PENCE = 5_000_000

/** Midnight today, UTC, which is what the route measures the window from. */
function midnightUtc(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
}

/** The comp as the route takes it, or the messages to show under the fields. */
export function validateComp(
  values: CompFormValues,
  now: Date = new Date()
): { ok: true; body: Omit<UkCompInput, "finish" | "condition"> } | { ok: false; errors: CompErrors } {
  const errors: CompErrors = {}

  const pence = parseDecimalToMinor(values.price.trim())
  if (pence === null || pence <= 0) {
    errors.price = "Enter the price it sold for, in pounds and pence, like 45.00."
  } else if (pence > MAX_COMP_PENCE) {
    // The route's words, so the counter hears the same thing either way.
    errors.price =
      "That price looks too high. Check it is in pence, not pounds, and try again."
  }

  if (!EBAY_ITEM_URL.test(values.url.trim())) {
    errors.url =
      "That is not an ebay.co.uk item link. Paste the listing's own URL (ebay.co.uk/itm/...)."
  }

  const soldAt = values.soldAt.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(soldAt)) {
    errors.soldAt = "Enter the date it sold, as YYYY-MM-DD."
  } else {
    const sold = new Date(`${soldAt}T00:00:00.000Z`)
    if (Number.isNaN(sold.getTime())) {
      errors.soldAt = "Enter the date it sold, as YYYY-MM-DD."
    } else {
      // Whole calendar days from midnight today, exactly as the route counts
      // them: measuring from "now" would refuse a comp sold 30 days ago for
      // anyone checking after midnight, and accept it for the early shift.
      const today = midnightUtc(now)
      const days = Math.round((today - sold.getTime()) / 864e5)
      if (sold.getTime() > today) {
        errors.soldAt = "That sale date is in the future."
      } else if (days > 30) {
        errors.soldAt =
          "That sale is more than 30 days old. A UK sold comp only counts as fresh within 30 days."
      }
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return {
    ok: true,
    body: { price: pence as number, url: values.url.trim(), sold_at: soldAt },
  }
}

/** Today as the date field wants it, which is also the sensible default. */
export function todayForInput(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}
