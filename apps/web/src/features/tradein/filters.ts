import type { TradeInSummary } from "@/lib/api"

/**
 * The three chips over the recent buy-ins, and what they leave on screen.
 *
 * Pure, and in its own file, so the rule can be unit tested and so the screen
 * beside it exports nothing but a component.
 */

export type Filter = "today" | "week" | "drafts"

export const FILTERS: { value: Filter; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "drafts", label: "Drafts" },
]

const DAY = 86_400_000

/** No chip pressed means everything; several are an "or", not an "and". */
export function applyFilters(
  rows: TradeInSummary[],
  active: Filter[],
  now: Date = new Date()
): TradeInSummary[] {
  if (active.length === 0) return rows
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const weekAgo = new Date(now.getTime() - 7 * DAY)

  return rows.filter((row) => {
    const at = row.at ? new Date(row.at) : null
    if (active.includes("drafts") && row.status === "draft") return true
    if (active.includes("today") && at && at >= startOfToday) return true
    if (active.includes("week") && at && at >= weekAgo) return true
    return false
  })
}
