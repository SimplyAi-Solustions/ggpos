import type { CustomerFlag, IdStatus } from "@/lib/api"

/**
 * The words the customers area uses for statuses, flags and dates.
 *
 * Kept apart from the screens so the list, the profile and the buy-in wizard
 * all say the same thing about the same customer, and so the copy rules in
 * DESIGN.md are reviewable in one place.
 */

export const ID_STATUS_LABEL: Record<IdStatus, string> = {
  none: "Not on file",
  verified: "Verified",
  expired: "Expired",
  rejected: "Rejected",
}

export const FLAG_LABEL: Record<CustomerFlag, string> = {
  no_cash: "No cash",
  watchlist: "Watchlist",
  under_18: "Under 18",
}

export const FLAG_REASON: Record<CustomerFlag, string> = {
  no_cash: "This customer is marked store credit only.",
  watchlist: "This customer is on the watchlist. Ask a manager before paying out.",
  under_18: "This customer is under 18, so cash is not an option.",
}

export const ALL_FLAGS: CustomerFlag[] = ["no_cash", "watchlist", "under_18"]

/** 18 June 2026, the way a receipt and a profile both write a date. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return ""
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  })
}

/** 18 Jun 2026, for table cells where the column has to stay narrow. */
export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return ""
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

/** True when an ID is on file, verified and still in date. */
export function idIsUsable(
  status: IdStatus | undefined,
  expiry: string | undefined,
  now: Date = new Date()
): boolean {
  if (status !== "verified") return false
  if (!expiry) return false
  const date = new Date(expiry)
  if (Number.isNaN(date.getTime())) return false
  return date.getTime() > now.getTime()
}

/** Whole years between a date of birth and today; null when unknown. */
export function ageFrom(dob: string | undefined, now: Date = new Date()): number | null {
  if (!dob) return null
  const born = new Date(dob)
  if (Number.isNaN(born.getTime())) return null
  let age = now.getFullYear() - born.getFullYear()
  const monthDelta = now.getMonth() - born.getMonth()
  if (monthDelta < 0 || (monthDelta === 0 && now.getDate() < born.getDate())) {
    age -= 1
  }
  return age
}

/** The portal link a customer card's QR code carries. */
export const PORTAL_ORIGIN = "https://vault.ggentertainment.co.uk"

export function portalLink(token: string | undefined): string {
  return `${PORTAL_ORIGIN}/c/${token ?? ""}`
}

/** The sentence shown wherever personal details are taken. */
export const PRIVACY_SENTENCE =
  "We keep your details to run the shop, to meet tax law, and to prevent crime. " +
  "You can ask us to see, correct or delete them at any time."

/** The line the ID step shows above the camera, from docs/privacy-notice.md. */
export const ID_PRIVACY_SENTENCE =
  "We photograph the ID to prevent and detect crime, keep it for up to twelve months, " +
  "and keep the name, address, ID type, last four digits and expiry for six years."
