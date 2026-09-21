/**
 * What the counter sends to the customer-facing display, and nothing else.
 *
 * The tablet on the counter faces the shop, so this is the one payload in
 * GG Vault built by subtraction: a line carries a title, a detail, a
 * quantity, a price and a picture, and everything else about the record it
 * came from is left behind. No record id, no SKU, no ID document field, no
 * phone number and no email address can reach it, because `scrubLine` and
 * `scrubPayload` only ever copy the keys named here.
 *
 * Pure, and unit tested against that promise.
 */
import type {
  DisplayBuyInLine,
  DisplayBuyInPayload,
  DisplayMode,
  DisplayPayload,
  DisplaySaleLine,
  DisplaySalePayload,
  PayoutType,
} from "@/lib/api/types"

/** A whole number of pence, never a float and never negative. */
function pence(value: number | undefined): number {
  const rounded = Math.round(value ?? 0)
  return Number.isFinite(rounded) ? rounded : 0
}

function text(value: string | undefined | null, max = 120): string {
  return (value ?? "").toString().trim().slice(0, max)
}

/**
 * The most of a customer's name the display may carry: a first name and a
 * last initial. The tablet faces the shop, so the queue behind sees enough
 * to know the screen is theirs and no more than that.
 */
export function shortName(name: string | undefined | null): string {
  const parts = text(name, 120).split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ""
  const [first, ...rest] = parts
  const last = rest[rest.length - 1]
  return last ? `${first} ${last.charAt(0).toUpperCase()}.` : first
}

export interface SaleLineInput {
  title: string
  detail?: string
  qty: number
  unitPrice: number
  image?: string
}

export interface SalePayloadInput {
  lines: SaleLineInput[]
  subtotal: number
  discount: number
  discountLabel?: string
  total: number
  pointsToEarn: number
  /** Shortened to a first name and a last initial on the way through. */
  customerName?: string
}

export function saleLine(line: SaleLineInput): DisplaySaleLine {
  const built: DisplaySaleLine = {
    title: text(line.title) || "Item",
    detail: text(line.detail),
    qty: Math.max(1, Math.round(line.qty || 1)),
    unit_price: pence(line.unitPrice),
  }
  const image = text(line.image, 2000)
  if (image) built.image_url = image
  return built
}

export function salePayload(input: SalePayloadInput): DisplaySalePayload {
  const payload: DisplaySalePayload = {
    lines: input.lines.map(saleLine),
    subtotal: pence(input.subtotal),
    discount: pence(input.discount),
    total: pence(input.total),
    points_to_earn: Math.max(0, Math.round(input.pointsToEarn || 0)),
  }
  const label = text(input.discountLabel, 60)
  if (label) payload.discount_label = label
  const name = shortName(input.customerName)
  if (name) payload.customer_name = name
  return payload
}

export interface BuyInLineInput {
  title: string
  detail?: string
  qty: number
  offerPrice: number
  image?: string
}

export interface BuyInPayloadInput {
  lines: BuyInLineInput[]
  totalMarket: number
  totalOffer: number
  payoutType: PayoutType
  /** Shortened to a first name and a last initial on the way through. */
  customerName: string
  creditBonusPoints?: number
}

export function buyInLine(line: BuyInLineInput): DisplayBuyInLine {
  const built: DisplayBuyInLine = {
    title: text(line.title) || "Item",
    detail: text(line.detail),
    qty: Math.max(1, Math.round(line.qty || 1)),
    offer_price: pence(line.offerPrice),
  }
  const image = text(line.image, 2000)
  if (image) built.image_url = image
  return built
}

export function buyInPayload(input: BuyInPayloadInput): DisplayBuyInPayload {
  const payload: DisplayBuyInPayload = {
    lines: input.lines.map(buyInLine),
    total_market: pence(input.totalMarket),
    total_offer: pence(input.totalOffer),
    payout_type: input.payoutType,
    customer_name: shortName(input.customerName),
  }
  if (input.creditBonusPoints && input.creditBonusPoints > 0) {
    payload.credit_bonus_points = Math.round(input.creditBonusPoints)
  }
  return payload
}

/**
 * A last pass over anything on its way to `POST /api/vault/display`, so a
 * payload built somewhere else can never carry a field the display has no
 * business showing. The route does the same on its side; this is the client
 * half of the same promise.
 */
export function scrubPayload(mode: DisplayMode, payload: unknown): DisplayPayload {
  if (mode === "idle" || !payload || typeof payload !== "object") return {}
  const raw = payload as Record<string, unknown>
  const lines = Array.isArray(raw.lines) ? (raw.lines as Record<string, unknown>[]) : []

  if (mode === "sale") {
    return salePayload({
      lines: lines.map((line) => ({
        title: String(line.title ?? ""),
        detail: String(line.detail ?? ""),
        qty: Number(line.qty ?? 1),
        unitPrice: Number(line.unit_price ?? 0),
        image: line.image_url ? String(line.image_url) : undefined,
      })),
      subtotal: Number(raw.subtotal ?? 0),
      discount: Number(raw.discount ?? 0),
      discountLabel: raw.discount_label ? String(raw.discount_label) : undefined,
      total: Number(raw.total ?? 0),
      pointsToEarn: Number(raw.points_to_earn ?? 0),
      customerName: raw.customer_name ? String(raw.customer_name) : undefined,
    })
  }

  return buyInPayload({
    lines: lines.map((line) => ({
      title: String(line.title ?? ""),
      detail: String(line.detail ?? ""),
      qty: Number(line.qty ?? 1),
      offerPrice: Number(line.offer_price ?? 0),
      image: line.image_url ? String(line.image_url) : undefined,
    })),
    totalMarket: Number(raw.total_market ?? 0),
    totalOffer: Number(raw.total_offer ?? 0),
    payoutType: (raw.payout_type as PayoutType) ?? "credit",
    customerName: String(raw.customer_name ?? ""),
    creditBonusPoints: Number(raw.credit_bonus_points ?? 0),
  })
}

/**
 * Whether two payloads say the same thing. The Sell screen publishes on a
 * 400ms debounce and only when this is false, so a screen that re-renders
 * for its own reasons does not put the tablet through a repaint.
 */
export function samePayload(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
