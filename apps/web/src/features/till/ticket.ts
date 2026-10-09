/**
 * The ticket: what is on it, what it costs and what goes to the server.
 *
 * Pure. Every figure is integer GBP pence, the perk, reward and points
 * arithmetic is the shared evaluator's, and nothing here touches React or
 * the network, so the till's maths is unit tested on its own.
 *
 * The figures follow `POST /api/vault/sales/complete` exactly
 * (docs/api-contract-epos.md, section 4): a line comes to
 * `unit_price * qty - discount`, the subtotal is those lines added up, and
 * the ticket discount (a tier perk, a manual amount, or a reward standing in
 * for both) comes off the subtotal and is spread back over the lines pro
 * rata, the last line taking the remainder, as the server does.
 */
import {
  applyPercent,
  evaluateSalePoints,
  formatGBP,
  roundHalfUp,
  spread,
  type SaleLineForPoints,
  type TierPerk,
  type TillCatalogueItem,
  type TillCatalogueProduct,
  type TillProductKind,
} from "@gg/shared"

import { formatPercent } from "@/lib/format"
import {
  initialState as tradeInitialState,
  reducer as tradeReducer,
  type TradeLine,
  type WizardAction,
} from "@/features/tradein/machine"
import type { RefundMethod } from "@/features/till/returns"
import { itemDetailLine, platformForItem } from "@/lib/api/item-shape"
import type {
  DiscountSource,
  ItemDetail,
  ItemKind,
  LoyaltySetup,
  RewardVoucher,
  SaleCustomer,
} from "@/lib/api/types"

/** A discount as staff keyed it: pounds off, or a percentage. */
export type Adjustment =
  | { kind: "none" }
  | { kind: "amount"; value: number }
  | { kind: "percent"; value: number }

export type TaxScheme = "margin" | "standard" | "zero" | "exempt"

export const NO_ADJUSTMENT: Adjustment = { kind: "none" }

/** The most of one till product a ticket can carry on a line. */
const PRODUCT_MAX_QTY = 99

export interface TicketLine {
  /** Stable for the line: the item id for stock, a minted id for a product. */
  key: string
  itemId: string | null
  productId: string | null
  productKind: TillProductKind | null
  /** The item's code, or "" for a till product. */
  sku: string
  title: string
  /** The one grey line under the title: set, number, finish. */
  detail: string
  kind: ItemKind | "product"
  condition: string
  image?: string
  /** A `PlatformKey` for the ProductImage frame. */
  platform: string
  unitPrice: number
  /** The item's or product's own price; for an open-price key, the price keyed. */
  listPrice: number
  openPrice: boolean
  qty: number
  /** 1 for singles, graded and retro; the stock line's quantity; 99 for a product. */
  maxQty: number
  game: string | null
  taxScheme: TaxScheme
  /** Percent. Only standard-rated lines carry VAT. */
  vatRate: number
  discount: Adjustment
  note: string
}

/** A line removed before payment: written as a void with the sale. */
export interface VoidedLine {
  title: string
  qty: number
  amount: number
}

/**
 * A part-exchange on the ticket (docs/api-contract-epos.md, section 7): the
 * buy-in wizard's own lines, saved to a draft trade-in for the ticket's
 * customer as they change. It belongs to that customer and nobody else, so
 * the customer cannot change while it is on the ticket.
 */
export interface TicketTrade {
  customerId: string
  customerName: string
  /** The draft `trade_ins` id, once it has been written. */
  tradeInId: string | null
  lines: TradeLine[]
}

/** A line of an earlier sale coming back in this ticket. */
export interface TicketReturnLine {
  /** The `sale_lines` id on the original sale. */
  saleLine: string
  title: string
  /** The code, or "Till product": the grey line under the title. */
  detail: string
  qty: number
  /** What these units come back at, from the shared breakdown. */
  amount: number
}

/**
 * Lines of one earlier sale brought back in this ticket, shown as negative
 * lines and sent as `returns` with the sale.
 */
export interface TicketReturn {
  saleId: string
  saleNumber: string
  /** Who the original sale was rung up to: a store credit refund goes to them. */
  customer: { id: string; name: string; code: string } | null
  lines: TicketReturnLine[]
  reason: string
  restock: boolean
  /** Where the original was mostly paid, which a refund of the difference defaults to. */
  refundMethod: RefundMethod
  /** The card it was paid on, to refund back to. */
  cardLast4: string
}

export interface Ticket {
  lines: TicketLine[]
  customer: SaleCustomer | null
  /** The manual ticket discount. */
  discount: Adjustment
  voucher: RewardVoucher | null
  voided: VoidedLine[]
  trade: TicketTrade | null
  returns: TicketReturn | null
}

export function emptyTicket(): Ticket {
  return {
    lines: [],
    customer: null,
    discount: NO_ADJUSTMENT,
    voucher: null,
    voided: [],
    trade: null,
    returns: null,
  }
}

/** Nothing on it at all: no lines, no trade-in and no return. */
export function ticketIsEmpty(ticket: Ticket): boolean {
  return ticket.lines.length === 0 && !ticket.trade && !ticket.returns
}

// ---------------------------------------------------------------------------
// Making lines
// ---------------------------------------------------------------------------

/** Singles, graded cards and retro are one row per unit, so they cap at one. */
export function maxQtyFor(kind: string, qty: number): number {
  if (kind === "sealed" || kind === "accessory") return Math.max(1, qty)
  return 1
}

/**
 * New supplier stock is standard rated and second-hand stock is margin
 * scheme (docs/PLAN.md, "VAT"). A catalogue tile does not say which, so
 * sealed product and accessories are taken as standard; the server's own
 * record is what the receipt and the reports use.
 */
function schemeForKind(kind: string): TaxScheme {
  return kind === "sealed" || kind === "accessory" ? "standard" : "margin"
}

export function lineFromItem(item: ItemDetail): TicketLine {
  return {
    key: item.id,
    itemId: item.id,
    productId: null,
    productKind: null,
    sku: item.sku,
    title: item.title || "Untitled item",
    detail: itemDetailLine(item),
    kind: item.kind,
    condition: item.condition || "",
    image: item.image,
    platform: item.platform || platformForItem(item),
    unitPrice: item.price ?? 0,
    listPrice: item.price ?? 0,
    openPrice: false,
    qty: 1,
    maxQty: maxQtyFor(item.kind, item.qty ?? 1),
    game: item.game || null,
    taxScheme: item.tax_scheme ?? schemeForKind(item.kind),
    // The item's own rate when it carries one (reduced, 5), else the
    // standard 20; the server's resolution is what is charged.
    vatRate: item.tax_scheme === "standard" && (item.vat_rate ?? 0) > 0 ? (item.vat_rate as number) : 20,
    discount: NO_ADJUSTMENT,
    note: "",
  }
}

const ITEM_KINDS: readonly string[] = ["single", "graded", "retro", "sealed", "accessory"]

function asItemKind(kind: string): ItemKind {
  return ITEM_KINDS.includes(kind) ? (kind as ItemKind) : "other"
}

/** A stock line from a tile or a dynamic category. */
export function lineFromCatalogueItem(item: TillCatalogueItem, label?: string): TicketLine {
  const kind = asItemKind(item.kind)
  return {
    key: item.id,
    itemId: item.id,
    productId: null,
    productKind: null,
    sku: item.sku,
    title: label?.trim() || item.title || "Untitled item",
    detail: "",
    kind,
    condition: "",
    image: item.image_url || undefined,
    platform: platformForItem({ kind }),
    unitPrice: item.price,
    listPrice: item.price,
    openPrice: false,
    qty: 1,
    maxQty: maxQtyFor(kind, item.qty),
    game: null,
    taxScheme: schemeForKind(kind),
    vatRate: 20,
    discount: NO_ADJUSTMENT,
    note: "",
  }
}

/**
 * A till product. An open-price key carries the price staff keyed, and an
 * optional few words saying what it was ("Single card: Charizard ex").
 */
export function lineFromProduct(
  product: TillCatalogueProduct,
  options: { key: string; price?: number; detail?: string; label?: string; vatRate?: number }
): TicketLine {
  const open = product.open_price || product.kind === "open_price"
  const price = open ? Math.max(0, Math.round(options.price ?? 0)) : product.price
  const name = options.label?.trim() || product.name
  const what = options.detail?.trim()
  return {
    key: options.key,
    itemId: null,
    productId: product.id,
    productKind: product.kind,
    sku: "",
    title: open && what ? `${name}: ${what}` : name,
    detail: "",
    kind: "product",
    condition: "",
    image: product.image_url || undefined,
    platform: "other",
    unitPrice: price,
    listPrice: price,
    openPrice: open,
    qty: 1,
    maxQty: product.kind === "membership" ? 1 : PRODUCT_MAX_QTY,
    game: null,
    taxScheme: product.tax_scheme,
    vatRate: options.vatRate ?? 20,
    discount: NO_ADJUSTMENT,
    note: "",
  }
}

// ---------------------------------------------------------------------------
// Line arithmetic
// ---------------------------------------------------------------------------

export function lineGross(line: Pick<TicketLine, "unitPrice" | "qty">): number {
  return line.unitPrice * line.qty
}

/** Pence a discount takes off an amount, never more than the amount itself. */
export function adjustmentAmount(adjustment: Adjustment, of: number): number {
  if (of <= 0) return 0
  if (adjustment.kind === "amount") return Math.min(of, Math.max(0, adjustment.value))
  if (adjustment.kind === "percent") {
    return Math.min(of, applyPercent(of, Math.min(100, Math.max(0, adjustment.value))))
  }
  return 0
}

export function lineDiscount(line: TicketLine): number {
  return adjustmentAmount(line.discount, lineGross(line))
}

/** What the line comes to before the ticket discount: the server's line total. */
export function lineNet(line: TicketLine): number {
  return lineGross(line) - lineDiscount(line)
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface LinePatch {
  qty?: number
  unitPrice?: number
  discount?: Adjustment
  note?: string
}

export type TicketAction =
  | { type: "add"; line: TicketLine }
  | { type: "setQty"; key: string; qty: number }
  | { type: "updateLine"; key: string; patch: LinePatch }
  | { type: "remove"; key: string }
  | { type: "attachCustomer"; customer: SaleCustomer | null }
  | { type: "setDiscount"; discount: Adjustment }
  | { type: "applyVoucher"; voucher: RewardVoucher | null }
  | { type: "load"; ticket: Ticket }
  | { type: "clear" }
  | { type: "startTrade"; customerId: string; customerName: string }
  | { type: "trade"; action: TradeLineAction }
  | { type: "dropTrade" }
  | { type: "rebaseTrade" }
  | { type: "setReturns"; returns: TicketReturn | null }

/** The wizard machine's line actions, which the ticket's trade takes as they are. */
export type TradeLineAction = Extract<
  WizardAction,
  { type: "add-line" | "update-line" | "remove-line" | "adopt-line-ids" | "set-draft" }
>

/**
 * A manual amount off never outlives the ticket it was typed against: when
 * the ticket shrinks below it the stored figure comes down with it, so what
 * is on screen and what is sent are the same number.
 */
function clampDiscount(ticket: Ticket): Ticket {
  if (ticket.discount.kind !== "amount") return ticket
  const subtotal = ticket.lines.reduce((sum, line) => sum + lineNet(line), 0)
  if (ticket.discount.value <= subtotal) return ticket
  return {
    ...ticket,
    discount: subtotal === 0 ? NO_ADJUSTMENT : { kind: "amount", value: subtotal },
  }
}

/** Same for a line's own discount when its price or quantity comes down. */
function clampLine(line: TicketLine): TicketLine {
  if (line.discount.kind !== "amount") return line
  const gross = lineGross(line)
  if (line.discount.value <= gross) return line
  return { ...line, discount: gross === 0 ? NO_ADJUSTMENT : { kind: "amount", value: gross } }
}

/** Whether a new line is more of one already on the ticket. */
export function sameThing(a: TicketLine, b: TicketLine): boolean {
  if (a.itemId && b.itemId) return a.itemId === b.itemId
  // An open-price key is a new line every time: two single cards at
  // different prices are two lines, not one line of two.
  if (a.productId && b.productId) return a.productId === b.productId && !a.openPrice && !b.openPrice
  return false
}

function voidOf(line: TicketLine, qty = line.qty): VoidedLine {
  const share = qty >= line.qty ? lineNet(line) : roundHalfUp((lineNet(line) * qty) / line.qty)
  return { title: line.title, qty, amount: share }
}

/**
 * Scanning the same code twice adds one more of a stock line and leaves a
 * single alone: a card is one row per unit and there is only ever one of it.
 */
export function ticketReducer(ticket: Ticket, action: TicketAction): Ticket {
  switch (action.type) {
    case "add": {
      const existing = ticket.lines.find((line) => sameThing(line, action.line))
      if (!existing) return { ...ticket, lines: [...ticket.lines, action.line] }
      if (existing.qty >= existing.maxQty) return ticket
      return {
        ...ticket,
        lines: ticket.lines.map((line) =>
          line === existing ? { ...line, qty: line.qty + 1 } : line
        ),
      }
    }
    case "setQty": {
      const qty = Math.max(0, Math.floor(action.qty))
      if (qty === 0) return ticketReducer(ticket, { type: "remove", key: action.key })
      return clampDiscount({
        ...ticket,
        lines: ticket.lines.map((line) =>
          line.key === action.key ? clampLine({ ...line, qty: Math.min(line.maxQty, qty) }) : line
        ),
      })
    }
    case "updateLine": {
      const { patch } = action
      return clampDiscount({
        ...ticket,
        lines: ticket.lines.map((line) => {
          if (line.key !== action.key) return line
          const next: TicketLine = { ...line }
          if (patch.qty !== undefined) {
            next.qty = Math.min(line.maxQty, Math.max(1, Math.floor(patch.qty)))
          }
          if (patch.unitPrice !== undefined) next.unitPrice = Math.max(0, Math.round(patch.unitPrice))
          if (patch.discount !== undefined) next.discount = patch.discount
          if (patch.note !== undefined) next.note = patch.note.trim().slice(0, 200)
          return clampLine(next)
        }),
      })
    }
    case "remove": {
      const removed = ticket.lines.find((line) => line.key === action.key)
      if (!removed) return ticket
      const lines = ticket.lines.filter((line) => line.key !== action.key)
      // Nothing left to take a reward off, so the reward comes off too.
      return clampDiscount({
        ...ticket,
        lines,
        voucher: lines.length === 0 ? null : ticket.voucher,
        voided: [...ticket.voided, voidOf(removed)],
      })
    }
    case "attachCustomer": {
      // A trade-in is drafted for one customer and completed against the
      // sale's customer, so the two cannot come apart (section 7).
      if (ticket.trade && action.customer?.id !== ticket.trade.customerId) return ticket
      // A voucher belongs to the customer who earned it.
      const voucher =
        ticket.voucher && ticket.voucher.customer !== action.customer?.id ? null : ticket.voucher
      // A membership is sold to somebody, so it goes when they do.
      const lines = action.customer
        ? ticket.lines
        : ticket.lines.filter((line) => line.productKind !== "membership")
      return { ...ticket, customer: action.customer, voucher, lines }
    }
    case "setDiscount":
      return clampDiscount({ ...ticket, discount: action.discount })
    case "applyVoucher":
      return { ...ticket, voucher: action.voucher }
    case "load":
      return action.ticket
    case "clear":
      return emptyTicket()
    case "startTrade": {
      // One part-exchange a ticket. A return can sit beside it: the trade
      // applies to the sale first, then the return (section 7).
      if (ticket.trade) return ticket
      return {
        ...ticket,
        trade: {
          customerId: action.customerId,
          customerName: action.customerName,
          tradeInId: null,
          lines: [],
        },
      }
    }
    case "trade": {
      const trade = ticket.trade
      if (!trade) return ticket
      // The buy-in wizard's own reducer, so a line is added, changed and
      // adopted on the till exactly as it is in the wizard.
      const next = tradeReducer(
        { ...tradeInitialState, tradeInId: trade.tradeInId, lines: trade.lines },
        action.action
      )
      if (next.lines === trade.lines && next.tradeInId === trade.tradeInId) return ticket
      return { ...ticket, trade: { ...trade, tradeInId: next.tradeInId, lines: next.lines } }
    }
    case "dropTrade":
      return ticket.trade ? { ...ticket, trade: null } : ticket
    case "rebaseTrade": {
      // The draft has gone from under the ticket: its lines are written
      // again to a new one.
      const trade = ticket.trade
      if (!trade) return ticket
      return {
        ...ticket,
        trade: {
          ...trade,
          tradeInId: null,
          lines: trade.lines.map((line) => ({ ...line, id: undefined })),
        },
      }
    }
    case "setReturns":
      return { ...ticket, returns: action.returns }
    default:
      return ticket
  }
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

export interface LineTotal {
  key: string
  gross: number
  lineDiscount: number
  /** Before the ticket discount: the server's line total. */
  net: number
  /** After the line's share of the ticket discount: what was paid for it. */
  paid: number
  vat: number
}

export interface TicketTotals {
  /** Before any discount at all. */
  gross: number
  lineDiscounts: number
  /** The lines added up after their own discounts: the server's subtotal. */
  subtotal: number
  /** Percent off from the customer's tier, the best that applies. */
  perkPercent: number
  perkDiscount: number
  manualDiscount: number
  voucherDiscount: number
  /** The ticket discount sent as `discount`, never more than the subtotal. */
  discount: number
  discountSource: DiscountSource | null
  total: number
  /** VAT inside the standard-rated lines, after discounts. */
  vat: number
  lines: LineTotal[]
}

function percentOffPerks(perks: TierPerk[]) {
  return perks.filter(
    (perk): perk is Extract<TierPerk, { type: "percent_off" }> => perk.type === "percent_off"
  )
}

/** The best percent off this ticket's kinds, and what it takes off. */
export function perkFor(
  lines: TicketLine[],
  customer: SaleCustomer | null
): { percent: number; amount: number } {
  if (!customer) return { percent: 0, amount: 0 }
  const perks = percentOffPerks(customer.perks)
  if (perks.length === 0) return { percent: 0, amount: 0 }

  let amount = 0
  let best = 0
  for (const line of lines) {
    const match = perks
      .filter((perk) => perk.scope.includes(line.kind))
      .sort((a, b) => b.value - a.value)[0]
    if (!match) continue
    best = Math.max(best, match.value)
    amount += applyPercent(lineNet(line), match.value)
  }
  return { percent: best, amount }
}

/** A money-off voucher is a discount; the other kinds are not money here. */
export function voucherDiscountFor(voucher: RewardVoucher | null): number {
  if (!voucher) return 0
  return voucher.type === "money_off" ? voucher.value : 0
}

/**
 * Why this reward cannot go on this ticket, or null when it can.
 *
 * The completion route wants a customer, `discount_source` of "reward" and a
 * discount equal to the reward's value, so a reward worth more than the
 * ticket can never be sent: it would have to be clamped, and a clamped
 * reward is not the reward.
 */
export function voucherProblem(
  voucher: RewardVoucher,
  customer: SaleCustomer | null,
  subtotal: number
): string | null {
  if (voucher.type !== "money_off") {
    return "That reward is not money off. Use it on the customer's account instead."
  }
  if (!customer || customer.id !== voucher.customer) {
    return "A reward needs the customer it was issued to on the sale."
  }
  if (voucher.value > subtotal) {
    return `This ${formatGBP(voucher.value)} reward is more than the ticket. Add another item or take the reward off.`
  }
  return null
}

/** VAT inside a gross amount at a rate, half-up: gross * rate / (100 + rate). */
export function vatInside(gross: number, rate: number): number {
  if (gross <= 0 || rate <= 0) return 0
  return roundHalfUp((gross * rate) / (100 + rate))
}

export function summarise(ticket: Ticket): TicketTotals {
  const grosses = ticket.lines.map(lineGross)
  const nets = ticket.lines.map(lineNet)
  const gross = grosses.reduce((sum, value) => sum + value, 0)
  const subtotal = nets.reduce((sum, value) => sum + value, 0)
  const perk = perkFor(ticket.lines, ticket.customer)
  const manual = adjustmentAmount(ticket.discount, subtotal)

  // A reward is the whole discount on a sale: the completion route checks
  // that `discount` equals the reward's value, so a perk or a manual amount
  // steps aside while one is applied rather than stacking on top of it.
  const voucher = voucherDiscountFor(ticket.voucher)
  const perkApplied = voucher > 0 ? 0 : perk.amount
  const manualApplied = voucher > 0 ? 0 : manual
  const discount = Math.min(subtotal, voucher > 0 ? voucher : perkApplied + manualApplied)

  const source: DiscountSource | null =
    voucher > 0
      ? "reward"
      : manualApplied > 0
        ? "manual"
        : perkApplied > 0
          ? "tier_perk"
          : null

  // The shared spread, the last line absorbing the remainder, so the lines
  // add up to the total exactly and the points preview sees what the
  // server will.
  const paid = spread(nets, discount)

  const lines: LineTotal[] = ticket.lines.map((line, index) => {
    const linePaid = paid[index] ?? 0
    return {
      key: line.key,
      gross: grosses[index] ?? 0,
      lineDiscount: (grosses[index] ?? 0) - (nets[index] ?? 0),
      net: nets[index] ?? 0,
      paid: linePaid,
      vat: line.taxScheme === "standard" ? vatInside(linePaid, line.vatRate) : 0,
    }
  })

  return {
    gross,
    lineDiscounts: gross - subtotal,
    subtotal,
    perkPercent: voucher > 0 ? 0 : perk.percent,
    perkDiscount: perkApplied,
    manualDiscount: manualApplied,
    voucherDiscount: voucher,
    discount,
    discountSource: source,
    total: subtotal - discount,
    vat: lines.reduce((sum, line) => sum + line.vat, 0),
    lines,
  }
}

/** What the ticket discount line is called, in the till's own words. */
export function discountLabel(ticket: Ticket, totals: TicketTotals): string {
  if (totals.discount <= 0) return ""
  if (totals.discountSource === "reward") return ticket.voucher?.rewardName ?? "Reward"
  if (totals.discountSource === "tier_perk") {
    return `${ticket.customer?.tierName ?? "Tier"} ${formatPercent(totals.perkPercent)} off`
  }
  return "Discount"
}

/**
 * Whether a manual discount is over the shop's limit, the way the server
 * reads it: a line discount against that line, the ticket discount against
 * the ticket. Only a manual amount counts; a perk or a reward is the
 * server's own arithmetic.
 */
export function overDiscountLimit(ticket: Ticket, limitPct: number): boolean {
  const totals = summarise(ticket)
  const over = (amount: number, of: number) => of > 0 && amount * 100 > of * limitPct
  if (ticket.lines.some((line) => over(lineDiscount(line), lineGross(line)))) return true
  return totals.manualDiscount > 0 && over(totals.discount, totals.subtotal)
}

/** The points this sale would earn, through the same evaluator the server runs. */
export function pointsPreview(
  ticket: Ticket,
  totals: TicketTotals,
  setup: LoyaltySetup | undefined,
  paidWithPoints: number
): number {
  if (!setup || !ticket.customer) return 0
  const lines: SaleLineForPoints[] = ticket.lines.map((line, index) => ({
    game: line.game,
    kind: line.kind === "product" ? "other" : line.kind,
    total: totals.lines[index]?.paid ?? 0,
  }))
  return evaluateSalePoints(setup.programme, setup.rules, {
    lines,
    at: new Date(),
    isFirstPurchase: false,
    isBirthdayMonth: false,
    tier: setup.tiers.find((tier) => tier.id === ticket.customer?.tierId) ?? null,
    paidWithPoints,
  }).total
}

/** How many things are on the ticket, counting a line of three as three. */
export function itemCount(ticket: Ticket): number {
  return ticket.lines.reduce((sum, line) => sum + line.qty, 0)
}

/** The stock ids on the ticket, for the parked-ticket clash warning. */
export function stockIds(ticket: Ticket): string[] {
  return ticket.lines.flatMap((line) => (line.itemId ? [line.itemId] : []))
}

// ---------------------------------------------------------------------------
// What goes to the server
// ---------------------------------------------------------------------------

export type SaleLineInput =
  | {
      item: string
      qty: number
      unit_price: number
      discount: number
      note?: string
    }
  | {
      product: string
      qty: number
      unit_price: number
      discount: number
      title?: string
      note?: string
    }

/**
 * The lines as `POST /api/vault/sales/complete` takes them. The price goes
 * on every line, so a changed price is the server's to check against the
 * item's own (`price_override`); an open-price product's title goes with it
 * when staff said what it was.
 */
export function saleLines(ticket: Ticket): SaleLineInput[] {
  return ticket.lines.map((line) => {
    const common = {
      qty: line.qty,
      unit_price: line.unitPrice,
      discount: lineDiscount(line),
      ...(line.note ? { note: line.note } : {}),
    }
    if (line.itemId) return { item: line.itemId, ...common }
    return {
      product: line.productId ?? "",
      ...common,
      ...(line.openPrice ? { title: line.title } : {}),
    }
  })
}
