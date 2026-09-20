/**
 * The words the Guild pages say, and the one piece of arithmetic behind the
 * tier rail.
 *
 * Pure and kept together, the way `format.ts` and `timeline.ts` already are:
 * the perks wallet, the refusal under a reward, the referral pitch and the
 * points history are all copy a reviewer should be able to read in one file
 * against the rules in DESIGN.md, rather than hunting through four screens.
 */
import { formatGBP } from "@gg/shared"

import type { GuildSummary, PortalReward, PortalVoucher } from "@/lib/api/guild"
import type {
  PerkWalletEntry,
  PointsLedgerRow,
  RewardType,
  VoucherStatus,
} from "@/lib/api/types"

// ---------------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------------

/** Points are integers, grouped the way a UK reader expects: 2,580. */
export function formatPoints(points: number): string {
  return Math.round(points).toLocaleString("en-GB")
}

/** "1 point", "2,580 points". */
export function pointsWord(points: number): string {
  const rounded = Math.round(points)
  return `${formatPoints(rounded)} ${Math.abs(rounded) === 1 ? "point" : "points"}`
}

/** A ledger row's movement, with its sign: "+320", "-500". */
export function pointsDelta(delta: number): string {
  const rounded = Math.round(delta)
  if (rounded === 0) return "0"
  return `${rounded < 0 ? "-" : "+"}${formatPoints(Math.abs(rounded))}`
}

/**
 * What one points row was for.
 *
 * The route writes a sentence per row, so that is what shows; this is the
 * fallback for a row that arrives without one, and for a reason added to the
 * server after this build. A row in somebody's own points history is never
 * left blank.
 */
const REASON_SENTENCE: Record<string, string> = {
  earn_sale: "Earned on a purchase",
  earn_trade_in: "Earned on a trade-in",
  rule_bonus: "Bonus points",
  welcome: "Welcome bonus",
  referral: "Referral bonus",
  redeem: "Redeemed for a reward",
  adjust: "Adjusted by the shop",
  expire: "Expired",
  refund_reverse: "Taken back after a refund",
}

export function pointsNote(row: Pick<PointsLedgerRow, "reason" | "note">): string {
  const spoken = row.note?.trim()
  if (spoken) return spoken
  return REASON_SENTENCE[row.reason] ?? "Points change"
}

// ---------------------------------------------------------------------------
// The tier rail
// ---------------------------------------------------------------------------

export interface TierRail {
  /** The customer's place along the rail, 0 to 1. */
  position: number
  /** The points figure at the far end, or null at the top tier. */
  target: number | null
  /** The tier that figure earns, or null at the top. */
  targetName: string | null
  atTop: boolean
}

/**
 * The rail runs from nothing to the next tier's threshold.
 *
 * `GET /api/vault/me/guild` sends the window points and how many more the
 * next tier needs, and nothing about where the tier they already hold began,
 * so the rail is drawn between the only two figures that are actually known:
 * zero and the next threshold, with the marker at the customer's own points.
 * Nothing on it is inferred, which is why the sentence beside it can carry
 * the same numbers without either contradicting the other.
 */
export function tierRail(
  summary: Pick<GuildSummary, "window_points" | "next">
): TierRail {
  const points = Math.max(0, Math.round(summary.window_points))
  if (!summary.next) {
    return { position: 1, target: null, targetName: null, atTop: true }
  }
  const target = points + Math.max(0, Math.round(summary.next.points_needed))
  const position = target > 0 ? Math.min(1, Math.max(0, points / target)) : 1
  return { position, target, targetName: summary.next.name, atTop: false }
}

/** "7,420 points to Legend", or "You are at the top". */
export function tierProgressSentence(
  summary: Pick<GuildSummary, "next">
): string {
  if (!summary.next) return "You are at the top"
  return `${pointsWord(summary.next.points_needed)} to ${summary.next.name}`
}

// ---------------------------------------------------------------------------
// The perks wallet
// ---------------------------------------------------------------------------

export interface PerkLine {
  /** The perk itself, in words: "5% off sealed product", "1.25x points". */
  title: string
  /** The month's counter, for the two perks that have one. */
  detail: string | null
}

/** The item kinds a percent-off perk is scoped to, as a customer says them. */
const SCOPE_WORD: Record<string, string> = {
  single: "singles",
  graded: "graded cards",
  retro: "retro games",
  sealed: "sealed product",
  accessory: "accessories",
  other: "everything else",
}

const ALL_KINDS = Object.keys(SCOPE_WORD)

/** "singles", "singles and sealed product", "singles, retro games and sealed product". */
export function listWords(words: string[]): string {
  if (words.length === 0) return ""
  if (words.length === 1) return words[0] as string
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`
}

export function scopeWords(scope: string[] | undefined): string {
  const kinds = scope ?? []
  if (kinds.length === 0) return "everything"
  if (ALL_KINDS.every((kind) => kinds.includes(kind))) return "everything"
  return listWords(kinds.map((kind) => SCOPE_WORD[kind] ?? kind))
}

/** 1.25 as "1.25", 2 as "2": a trailing zero on a multiplier reads as noise. */
export function formatMultiplier(value: number): string {
  return String(Number(value.toFixed(2)))
}

/** "1 of 2 used this month". */
export function perkCountLine(entry: PerkWalletEntry): string {
  const allowed = Math.max(0, Math.round(entry.allowed ?? 0))
  const used = Math.min(allowed, Math.max(0, Math.round(entry.used ?? 0)))
  if (allowed === 0) return "None this month"
  return `${formatPoints(used)} of ${formatPoints(allowed)} used this month`
}

export function perkLine(entry: PerkWalletEntry): PerkLine {
  switch (entry.type) {
    case "free_event_entries":
      return { title: "Free event entries", detail: perkCountLine(entry) }
    case "lounge_hours":
      return { title: "Lounge hours", detail: perkCountLine(entry) }
    case "percent_off":
      return {
        title: `${entry.value ?? 0}% off ${scopeWords(entry.scope)}`,
        detail: null,
      }
    case "points_multiplier":
      return {
        title: `${formatMultiplier(entry.value ?? 1)}x points`,
        detail: null,
      }
    case "priority_release_booking":
      return { title: "Priority booking on new releases", detail: null }
    case "member_event_pricing":
      return { title: "Member prices at events", detail: null }
    default:
      return { title: "Member perk", detail: null }
  }
}

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------

/**
 * The pitch under the referral code.
 *
 * Both bonuses come off the programme, so the sentence says what each side
 * actually gets rather than assuming they match, and drops the promise
 * altogether when the programme pays nothing.
 */
export function referralSentence(referral: {
  bonus_referrer: number
  bonus_referee: number
}): string {
  const lead = "Give a friend this code when they join at the counter."
  const referrer = Math.max(0, Math.round(referral.bonus_referrer))
  const referee = Math.max(0, Math.round(referral.bonus_referee))
  if (referrer === 0 && referee === 0) return lead
  if (referrer === referee) {
    return `${lead} You both get ${pointsWord(referrer)} after their first buy-in or purchase.`
  }
  return `${lead} They get ${pointsWord(referee)} and you get ${pointsWord(referrer)} after their first buy-in or purchase.`
}

/** How the people who used the code are getting on. */
export function referralProgressSentence(earned: number, pending: number): string {
  const done = Math.max(0, Math.round(earned))
  const waiting = Math.max(0, Math.round(pending))
  const friends = (count: number) => `${count} friend${count === 1 ? "" : "s"}`
  if (done === 0 && waiting === 0) return "Nobody has used your code yet."
  const still =
    waiting === 1
      ? "is still to make their first visit"
      : "are still to make their first visit"
  if (done === 0) return `${friends(waiting)} ${waiting === 1 ? "has" : "have"} joined and ${still}.`
  const earnedPart = `${friends(done)} ${done === 1 ? "has" : "have"} earned you points`
  if (waiting === 0) return `${earnedPart}.`
  return `${earnedPart}, and ${waiting} ${still}.`
}

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

/**
 * The whole programme is off, which is nothing to do with any one reward.
 *
 * The route sends `off` on every row, so the screens say it once above the
 * list rather than printing the same sentence under each name.
 */
export const PROGRAMME_OFF =
  "The rewards programme is switched off at the moment. Ask at the counter."

/** True when the catalogue came back with the programme switched off. */
export function programmeIsOff(
  rewards: Pick<PortalReward, "reason">[]
): boolean {
  return rewards.length > 0 && rewards.every((reward) => reward.reason === "off")
}

/**
 * Why this one cannot be redeemed yet, or null when it can.
 *
 * The server sends the reason as a word and refuses again on the redeem
 * itself; this is the same refusal said in front of the customer before they
 * press anything, so the button and the sentence under it never disagree.
 *
 * `pointsBalance` is null while the balance is still being read. The
 * sentence then says what the reward costs and stops: "and have 0" would be
 * a statement about somebody's own points that is not true yet.
 */
export function rewardReasonSentence(
  reward: Pick<PortalReward, "can_redeem" | "reason" | "cost_points">,
  pointsBalance: number | null
): string | null {
  if (reward.can_redeem) return null
  switch (reward.reason) {
    case "off":
      return PROGRAMME_OFF
    case "insufficient":
      return pointsBalance === null
        ? `You need ${formatPoints(reward.cost_points)} points for this.`
        : `You need ${formatPoints(reward.cost_points)} points and have ${formatPoints(pointsBalance)}.`
    case "sold_out":
      return "None left at the moment."
    case "limit_reached":
      return "You have had this one already."
    case "not_yet":
      return "This one is not open yet."
    default:
      return "Not available just now."
  }
}

/** "£5.00 of store credit", "One free item". */
export function rewardWorth(type: RewardType, value: number): string {
  switch (type) {
    case "money_off":
      return `${formatGBP(value)} off a purchase`
    case "store_credit":
      return `${formatGBP(value)} of store credit`
    case "free_item":
      return "One free item"
    case "event_entry":
      return "One event entry"
    default:
      return ""
  }
}

/**
 * The admin's description, as paragraphs of plain text.
 *
 * `description_html` comes out of PocketBase's editor field, and a portal
 * screen is the last place to hand a browser markup it did not write. The
 * tags come out here, the text stays, and a paragraph break survives as a
 * paragraph break.
 */
export function descriptionParagraphs(html: string | undefined): string[] {
  if (!html) return []
  const text = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|blockquote|tr)>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
  return decodeEntities(text)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean)
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  pound: "£",
  hellip: "...",
}

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body.startsWith("#x") || body.startsWith("#X")
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

// ---------------------------------------------------------------------------
// Vouchers
// ---------------------------------------------------------------------------

const STATUS_WORD: Record<VoucherStatus, string> = {
  issued: "Ready to use",
  used: "Used",
  expired: "Expired",
  cancelled: "Cancelled",
}

/** True once the expiry has passed, whether or not the cron has caught up. */
export function voucherRunOut(
  voucher: Pick<PortalVoucher, "expires_at">,
  now: Date = new Date()
): boolean {
  if (!voucher.expires_at) return false
  const at = new Date(voucher.expires_at).getTime()
  return !Number.isNaN(at) && at < now.getTime()
}

/**
 * The state in a word.
 *
 * An `issued` voucher past its expiry reads "Expired" rather than "Ready to
 * use": the nightly cron writes that status hours later, and a customer at
 * the counter should not be told a dead voucher is good.
 */
export function voucherStatusWord(
  voucher: Pick<PortalVoucher, "status" | "expires_at">,
  now: Date = new Date()
): string {
  if (voucher.status === "issued" && voucherRunOut(voucher, now)) return "Expired"
  return STATUS_WORD[voucher.status] ?? "In progress"
}

/** Can this one still be shown at the counter and scanned? */
export function voucherIsLive(
  voucher: Pick<PortalVoucher, "status" | "expires_at">,
  now: Date = new Date()
): boolean {
  return voucher.status === "issued" && !voucherRunOut(voucher, now)
}
