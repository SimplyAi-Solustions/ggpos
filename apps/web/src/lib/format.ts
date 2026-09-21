/**
 * Display formats the whole app shares, for the figures `@gg/shared` does not
 * own. Money lives there (`formatGBP`); this file is what the screens use for
 * everything else that has to read the same way twice.
 */

/**
 * A percentage, in the one format the app shows: the figure, no space, then
 * the sign. A whole number carries no decimal (`10%`), and anything finer
 * carries exactly one place (`32.6%`), so a column of them lines up under
 * `tnum`. Give the string the `tnum` class wherever it is a figure rather
 * than a word in a sentence.
 */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%"
  const rounded = Math.round(value * 10) / 10
  // `toFixed(1)` would print 10.0%; a whole number reads better without it.
  const digits = Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)
  return `${digits}%`
}
