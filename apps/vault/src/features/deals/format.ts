import { roundHalfUp } from "@gg/shared/money"

/** 80 as "80%", 82.46 as "82.5%". Half-up, never Math.round. Empty for a missing figure. */
export function formatPct(pct: number | null | undefined): string {
  if (typeof pct !== "number" || !Number.isFinite(pct)) return ""
  const tenths = roundHalfUp(pct * 10)
  return tenths % 10 === 0 ? `${tenths / 10}%` : `${(tenths / 10).toFixed(1)}%`
}

/** "just now", "5 min ago", "3 h ago", then "9 Nov" (and the year when it is not this year). */
export function formatUpdated(iso: string, now: Date = new Date()): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ""
  const seconds = Math.max(0, (now.getTime() - at.getTime()) / 1000)
  if (seconds < 60) return "just now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86400 && at.getDate() === now.getDate()) return `${Math.floor(seconds / 3600)} h ago`
  return at.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  })
}

/** "holo" as "Holo", "reverse-holo" as "Reverse holo". */
export function variantLabel(finish: string): string {
  const text = finish.replace(/[-_]+/g, " ").trim()
  if (!text) return ""
  return text.charAt(0).toUpperCase() + text.slice(1)
}
