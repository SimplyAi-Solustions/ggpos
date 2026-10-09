/**
 * The few sentences the Guild says at the counter, in one place so the till,
 * the customer page and the join sheet say them the same way.
 */

/** "They get 100 points to start." */
export function joinIntro(welcomeBonus: number): string {
  if (welcomeBonus <= 0) return "Every purchase earns points from today."
  return `They get ${welcomeBonus.toLocaleString("en-GB")} points to start.`
}

/** What the till says once somebody has joined. */
export function joinedNote(name: string, welcomePoints: number): string {
  if (welcomePoints <= 0) return `${name} joined the Guild.`
  return `${name} joined the Guild with ${welcomePoints.toLocaleString("en-GB")} points.`
}

/**
 * What was typed into the customer search, put where it belongs on a new
 * customer: an address is the email, a run of digits is the phone, and
 * anything else is their name.
 */
export function seedFromQuery(query: string): { name: string; email: string; phone: string } {
  const typed = query.trim()
  if (typed.includes("@")) return { name: "", email: typed, phone: "" }
  if (/^\+?[\d\s()-]{6,}$/.test(typed)) return { name: "", email: "", phone: typed }
  return { name: typed, email: "", phone: "" }
}

const LONG_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Europe/London",
})

/** "In the Guild since 9 October 2026", from PocketBase's stored date or ISO. */
export function memberSince(joinedAt: string): string {
  const at = new Date(joinedAt.trim().replace(" ", "T"))
  if (Number.isNaN(at.getTime())) return "In the Guild"
  return `In the Guild since ${LONG_DATE.format(at)}`
}
