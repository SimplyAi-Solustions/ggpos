import { roundHalfUp } from "@gg/shared"

/**
 * Display formats the whole app shares, for the figures `@gg/shared` does not
 * own. Money lives there (`formatGBP`); this file is what the screens use for
 * everything else that has to read the same way twice.
 */

/**
 * A percentage, in the one format the app shows: the figure, no space, then
 * the sign. A whole number carries no decimal (`10%`) rather than a dead
 * trailing zero, and anything finer carries exactly one place (`32.6%`).
 * Give the string the `tnum` class wherever it is a figure rather than a word
 * in a sentence.
 *
 * Rounding goes through the repo's own `roundHalfUp`, which is symmetric for
 * negatives; `Math.round` takes a negative half towards zero and would print
 * -15.45 as -15.4% while every other figure in the app rounded it to -15.5.
 *
 * A figure that is missing or not a number has no percentage to show, so it
 * returns an empty string: the caller decides what to put in its place, and
 * nobody reads a confident "0%" off a field somebody is halfway through
 * retyping.
 */
export function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return ""
  const rounded = roundHalfUp(value * 10) / 10
  const digits = Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)
  return `${digits}%`
}
