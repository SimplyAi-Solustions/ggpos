/**
 * The three schedules a saved report can carry, and what each reads as.
 *
 * Kept out of the component file so the select and the saved-views line can
 * both name a schedule without either importing the other's module.
 * `weekly` sends on a Monday for the week that just ended, `monthly` on the
 * 1st for the month that just ended (docs/api-contract.md, "Saved and
 * scheduled reports").
 */
import type { ReportSchedule } from "@/lib/api/types"

export const SCHEDULES: { key: ReportSchedule; label: string }[] = [
  { key: "none", label: "Do not send" },
  { key: "weekly", label: "Every Monday" },
  { key: "monthly", label: "On the 1st" },
]

export function scheduleLabel(schedule?: ReportSchedule): string {
  return SCHEDULES.find((entry) => entry.key === (schedule ?? "none"))?.label ?? ""
}
