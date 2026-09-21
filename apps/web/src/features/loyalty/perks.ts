/**
 * The perks wallet: what a tier allows this month, what has been used, and
 * what the counter says when there is nothing left.
 *
 * Pure. The counted perks (free event entries, lounge hours) run on a
 * calendar month in Europe/London, which is the period the `perk_usage`
 * unique index is keyed on, so the month is worked out here once rather than
 * in each screen.
 */
import type { CountedPerkType, PerkWalletEntry } from "@/lib/api/types"
import type { TierPerk } from "@gg/shared"
import { formatPercent } from "@/lib/format"

/** The current period, `YYYY-MM`, in the shop's own timezone. */
export function currentPeriod(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now)
  const year = parts.find((part) => part.type === "year")?.value ?? "0000"
  const month = parts.find((part) => part.type === "month")?.value ?? "01"
  return `${year}-${month}`
}

/** The first of next month, as "1 Oct", for the sentence about waiting. */
export function nextPeriodDate(now: Date = new Date()): string {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 12, 0, 0)
  )
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "short",
  }).format(next)
}

export const COUNTED_PERKS: CountedPerkType[] = [
  "free_event_entries",
  "lounge_hours",
]

export const PERK_LABEL: Record<TierPerk["type"], string> = {
  percent_off: "Percent off",
  points_multiplier: "Points multiplier",
  free_event_entries: "Free event entries",
  lounge_hours: "Lounge hours",
  priority_release_booking: "Priority release booking",
  member_event_pricing: "Member event pricing",
}

export function isCountedPerk(type: string): type is CountedPerkType {
  return type === "free_event_entries" || type === "lounge_hours"
}

/** What is left of a monthly allowance, never below zero. */
export function remaining(entry: PerkWalletEntry): number {
  return Math.max(0, (entry.allowed ?? 0) - (entry.used ?? 0))
}

/** "2 of 2 left this month", the line under a counted perk. */
export function perkCountLine(entry: PerkWalletEntry): string {
  const allowed = entry.allowed ?? 0
  return `${remaining(entry).toLocaleString("en-GB")} of ${allowed.toLocaleString("en-GB")} left this month`
}

/** What one entry is worth, in words, for the informational perks. */
export function perkValueLine(entry: PerkWalletEntry): string {
  switch (entry.type) {
    case "percent_off": {
      const scope = entry.scope ?? []
      const where = scope.length > 0 ? scope.join(", ") : "everything"
      return `${formatPercent(entry.value ?? 0)} off ${where}`
    }
    case "points_multiplier":
      return `${entry.value ?? 1} times the points on a sale`
    case "priority_release_booking":
      return "Books a release before general sale"
    case "member_event_pricing":
      return "Member price at ticketed events"
    default:
      return perkCountLine(entry)
  }
}

/**
 * The server's own refusal when an allowance is spent, said the same way
 * here so the button's reason and the route's message agree.
 */
export function perkRefusal(
  type: CountedPerkType,
  allowed: number,
  now: Date = new Date()
): string {
  const on = nextPeriodDate(now)
  if (allowed <= 0) {
    return type === "free_event_entries"
      ? "This tier has no free event entries. Change the tier's perks to add some."
      : "This tier has no lounge hours. Change the tier's perks to add some."
  }
  if (type === "free_event_entries") {
    if (allowed === 1) return `The free entry this month is used. The next one comes on ${on}.`
    if (allowed === 2) return `Both free entries this month are used. The next two come on ${on}.`
    return `All ${allowed} free entries this month are used. The next ${allowed} come on ${on}.`
  }
  if (allowed === 1) return `The lounge hour this month is used. The next one comes on ${on}.`
  return `All ${allowed} lounge hours this month are used. The next ${allowed} come on ${on}.`
}

/** The wallet a tier's perks make, before any usage is counted in. */
export function walletFromPerks(
  perks: TierPerk[],
  used: Partial<Record<CountedPerkType, number>>,
  period: string
): PerkWalletEntry[] {
  return perks.map((perk) => {
    if (perk.type === "free_event_entries" || perk.type === "lounge_hours") {
      return {
        type: perk.type,
        value: perk.value,
        allowed: perk.value,
        used: used[perk.type] ?? 0,
        period,
      }
    }
    if (perk.type === "percent_off") {
      return { type: perk.type, value: perk.value, scope: perk.scope }
    }
    if (perk.type === "points_multiplier") {
      return { type: perk.type, value: perk.value }
    }
    return { type: perk.type }
  })
}
