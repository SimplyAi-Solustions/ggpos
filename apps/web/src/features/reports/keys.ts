/**
 * Which strings are report keys.
 *
 * Its own module, and deliberately tiny: the `$key` route guards on this in
 * `beforeLoad`, which the router keeps in the main tree rather than in the
 * route's lazy chunk. Importing the specs there would drag every report's
 * columns, labels and chart config into the entry bundle for the sake of one
 * membership test.
 */
import { REPORT_KEYS, type ReportKey } from "@/lib/api/types"

export function isReportKey(value: string): value is ReportKey {
  return (REPORT_KEYS as readonly string[]).includes(value)
}
