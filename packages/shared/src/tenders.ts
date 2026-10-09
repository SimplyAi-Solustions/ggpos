/**
 * How a sale is paid, and how a refund goes back (docs/api-contract-epos.md,
 * section 4).
 *
 * Pure and shared: the till runs these before it sends a sale or a refund,
 * and the server runs the same functions (through the generated copy in
 * pb/pb_hooks/lib/shared/tenders.js) before it writes anything, so the
 * counter and the server say the same sentence about the same mistake. The
 * server's answer is the one that counts; balances, the cash cap and the open
 * session are checked there against live records.
 *
 * Money is integer GBP pence. A tender's `amount` is what it puts against the
 * sale; only cash gives change, and the change is what was handed over less
 * that amount. The cash that stays in the drawer is the amount, never what
 * was handed over.
 */
import { formatGBP } from "./money"
import { TENDER_LABELS, type Tender, type TenderInput, type TenderMethod } from "./epos-types"

/** The most tenders one sale or refund may carry. */
export const MAX_TENDERS = 10

/** The methods a refund can go back by. */
export const REFUND_TENDERS = ["cash", "card_tide", "store_credit"] as const
export type RefundTender = (typeof REFUND_TENDERS)[number]

/** A tender once it has passed the rules, in the shape `sale_tenders` stores. */
export interface CheckedTender {
  method: TenderMethod
  amount: number
  tendered: number
  change: number
  card_last4: string
  reference: string
}

/**
 * Why a set of tenders was refused. `needs_customer` is the one the server
 * answers with 422 rather than 400, as it always has; everything else is a
 * malformed request.
 */
export type TenderProblemCode = "invalid" | "needs_customer"

export type TenderCheck =
  | { ok: true; tenders: CheckedTender[]; paid: number; change: number; cash: number }
  | { ok: false; code: TenderProblemCode; message: string }

export interface SaleTenderRules {
  /** What the sale comes to after every discount. */
  total: number
  /** `settings.epos.require_card_last4`. */
  requireCardLast4: boolean
  /** Store credit and points belong to a customer. */
  hasCustomer: boolean
}

export interface RefundTenderRules {
  /** What the chosen lines and quantities come to (the shared `breakdown`). */
  amount: number
  /** A refund to store credit needs the sale's customer. */
  hasCustomer: boolean
}

export const SUMUP_GONE = "SumUp is no longer used. Take card payments on the Tide reader."
export const PART_EXCHANGE_LATER = "Part-exchange is not available yet."
export const CARD_LAST4 = "Key the last four digits of the card."
export const NEEDS_CUSTOMER = "Add the customer before using store credit or points."
export const REFUND_NEEDS_CUSTOMER = "This sale has no customer, so it cannot go back as store credit."

const SALE_METHODS: readonly string[] = ["cash", "card_tide", "store_credit", "points"]

function isEmpty(input: unknown): boolean {
  return input === undefined || input === null || (Array.isArray(input) && input.length === 0)
}

function isWholePence(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
}

/** A text field off an untyped tender, trimmed; "" when absent. */
function textOf(value: unknown): string {
  if (value === null || value === undefined) return ""
  return String(value).trim()
}

/** The sentence for the payments not adding up to the total. */
export function sumProblem(paid: number, total: number): string {
  return `The payments come to ${formatGBP(paid)} but the total is ${formatGBP(total)}.`
}

/** Change due on a cash tender: what was handed over less what it pays, never below zero. */
export function changeDue(tendered: number, amount: number): number {
  return Math.max(0, tendered - amount)
}

/** What is still to pay once these tenders are taken; negative when they come to more. */
export function amountDue(total: number, tenders: readonly { amount: number }[]): number {
  return tenders.reduce((left, tender) => left - tender.amount, total)
}

/** `sales.payment` for a set of tenders: the one method, or "mixed". */
export function paymentFor(tenders: readonly { method: TenderMethod }[]): TenderMethod | "mixed" {
  const methods = new Set(tenders.map((tender) => tender.method))
  if (methods.size === 1) return tenders[0]!.method
  return "mixed"
}

/**
 * `sales.payment_split` mirrored from the tenders, for reports written before
 * tenders existed. The four original keys are always present (`sumup_card`
 * at 0 on every new sale); any other method appears when it was used.
 */
export function splitFor(tenders: readonly { method: TenderMethod; amount: number }[]): Record<string, number> {
  const split: Record<string, number> = { sumup_card: 0, cash: 0, store_credit: 0, points: 0, card_tide: 0 }
  for (const tender of tenders) {
    split[tender.method] = (split[tender.method] ?? 0) + tender.amount
  }
  return split
}

/** A stored or checked tender as the routes return it, with its label. */
export function toTender(row: {
  method: TenderMethod
  amount: number
  tendered?: number
  change?: number
  card_last4?: string
  reference?: string
}): Tender {
  return {
    method: row.method,
    label: TENDER_LABELS[row.method] ?? row.method,
    amount: row.amount,
    tendered: row.tendered ?? 0,
    change: row.change ?? 0,
    card_last4: row.card_last4 ?? "",
    reference: row.reference ?? "",
  }
}

/** The card fields common to a sale and a refund: last four digits and a reference. */
function cardFields(
  raw: Partial<TenderInput>,
  requireLast4: boolean
): { ok: true; last4: string; reference: string } | { ok: false; message: string } {
  const last4 = textOf(raw.card_last4)
  if ((requireLast4 || last4 !== "") && !/^\d{4}$/.test(last4)) {
    return { ok: false, message: CARD_LAST4 }
  }
  const reference = textOf(raw.reference)
  if (reference.length > 60) {
    return { ok: false, message: "Keep the card reference to 60 characters." }
  }
  return { ok: true, last4, reference }
}

/**
 * The tenders for a sale against the contract's rules: every tender a known
 * till method with an amount above zero, at most one cash tender, cash
 * handed over at least what it pays, change from cash only, the card's last
 * four digits when the shop asks for them, a customer for store credit and
 * points, and the whole lot summing to the total exactly.
 */
export function checkSaleTenders(input: unknown, rules: SaleTenderRules): TenderCheck {
  // A sale that comes to nothing (a reward or a perk covering all of it)
  // takes no payment at all.
  if (rules.total === 0 && isEmpty(input)) {
    return { ok: true, tenders: [], paid: 0, change: 0, cash: 0 }
  }
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, code: "invalid", message: "Add how the customer is paying." }
  }
  if (input.length > MAX_TENDERS) {
    return {
      ok: false,
      code: "invalid",
      message: `A sale can take up to ${MAX_TENDERS} payments. Put some of them together.`,
    }
  }

  const tenders: CheckedTender[] = []
  let cashSeen = false
  let paid = 0
  let change = 0
  let cash = 0

  for (const entry of input) {
    const raw = (entry && typeof entry === "object" ? entry : {}) as Partial<TenderInput> & {
      method?: unknown
    }
    const method = textOf(raw.method)
    if (method === "sumup_card") return { ok: false, code: "invalid", message: SUMUP_GONE }
    if (method === "part_exchange") return { ok: false, code: "invalid", message: PART_EXCHANGE_LATER }
    if (!SALE_METHODS.includes(method)) {
      return {
        ok: false,
        code: "invalid",
        message: "Pick how the customer is paying: cash, card, store credit or points.",
      }
    }
    const amount = raw.amount
    if (!isWholePence(amount) || amount <= 0) {
      return { ok: false, code: "invalid", message: `Each payment needs an amount above ${formatGBP(0)}.` }
    }

    let tendered = amount
    let changeHere = 0
    let last4 = ""
    let reference = ""

    if (method === "cash") {
      if (cashSeen) {
        return {
          ok: false,
          code: "invalid",
          message: "There are two cash payments. Put the cash together as one payment.",
        }
      }
      cashSeen = true
      if (raw.tendered !== undefined && raw.tendered !== null) {
        if (!isWholePence(raw.tendered) || raw.tendered < amount) {
          const handed = isWholePence(raw.tendered) ? formatGBP(raw.tendered) : "The cash handed over"
          return {
            ok: false,
            code: "invalid",
            message: `${handed} does not cover the ${formatGBP(amount)} cash payment. Key what the customer handed over.`,
          }
        }
        tendered = raw.tendered
      }
      changeHere = changeDue(tendered, amount)
      cash = amount
    } else {
      if (raw.tendered !== undefined && raw.tendered !== null && raw.tendered !== amount) {
        return {
          ok: false,
          code: "invalid",
          message: "Only cash gives change. Key the exact amount for every other payment.",
        }
      }
      if (method === "card_tide") {
        const card = cardFields(raw, rules.requireCardLast4)
        if (!card.ok) return { ok: false, code: "invalid", message: card.message }
        last4 = card.last4
        reference = card.reference
      }
      if ((method === "store_credit" || method === "points") && !rules.hasCustomer) {
        return { ok: false, code: "needs_customer", message: NEEDS_CUSTOMER }
      }
    }

    paid += amount
    change += changeHere
    tenders.push({
      method: method as TenderMethod,
      amount,
      tendered,
      change: changeHere,
      card_last4: last4,
      reference,
    })
  }

  if (paid !== rules.total) {
    return { ok: false, code: "invalid", message: sumProblem(paid, rules.total) }
  }

  return { ok: true, tenders, paid, change, cash }
}

/**
 * The tenders for a refund: cash, the Tide card or store credit, each above
 * zero, at most one cash tender, and together exactly the refund amount. A
 * card refund is keyed on the Tide reader by hand; its last four digits are
 * optional, but checked when given. `amount` on the way in is positive (what
 * goes back); the server stores it negative.
 */
export function checkRefundTenders(input: unknown, rules: RefundTenderRules): TenderCheck {
  // Lines that came to nothing (fully discounted) go back with no money.
  if (rules.amount === 0 && isEmpty(input)) {
    return { ok: true, tenders: [], paid: 0, change: 0, cash: 0 }
  }
  if (!Array.isArray(input) || input.length === 0) {
    return {
      ok: false,
      code: "invalid",
      message: "Say how the refund is going back: cash, card or store credit.",
    }
  }
  if (input.length > MAX_TENDERS) {
    return {
      ok: false,
      code: "invalid",
      message: `A refund can go back in up to ${MAX_TENDERS} payments. Put some of them together.`,
    }
  }

  const tenders: CheckedTender[] = []
  let cashSeen = false
  let paid = 0
  let cash = 0

  for (const entry of input) {
    const raw = (entry && typeof entry === "object" ? entry : {}) as Partial<TenderInput> & {
      method?: unknown
    }
    const method = textOf(raw.method)
    if (method === "sumup_card") {
      return {
        ok: false,
        code: "invalid",
        message: "SumUp is no longer used. Refund card payments on the Tide reader.",
      }
    }
    if (!(REFUND_TENDERS as readonly string[]).includes(method)) {
      return {
        ok: false,
        code: "invalid",
        message: "Say how the refund is going back: cash, card or store credit.",
      }
    }
    const amount = raw.amount
    if (!isWholePence(amount) || amount <= 0) {
      return { ok: false, code: "invalid", message: `Each payment back needs an amount above ${formatGBP(0)}.` }
    }

    let last4 = ""
    let reference = ""
    if (method === "cash") {
      if (cashSeen) {
        return {
          ok: false,
          code: "invalid",
          message: "There are two cash payments back. Put the cash together as one payment.",
        }
      }
      cashSeen = true
      cash = amount
    } else if (method === "card_tide") {
      const card = cardFields(raw, false)
      if (!card.ok) return { ok: false, code: "invalid", message: card.message }
      last4 = card.last4
      reference = card.reference
    } else if (!rules.hasCustomer) {
      return { ok: false, code: "needs_customer", message: REFUND_NEEDS_CUSTOMER }
    }

    paid += amount
    tenders.push({
      method: method as TenderMethod,
      amount,
      tendered: 0,
      change: 0,
      card_last4: last4,
      reference,
    })
  }

  if (paid !== rules.amount) {
    return {
      ok: false,
      code: "invalid",
      message: `The payments back come to ${formatGBP(paid)} but the refund is ${formatGBP(rules.amount)}.`,
    }
  }

  return { ok: true, tenders, paid, change: 0, cash }
}
