import { displayCode, formatGBP } from "@gg/shared"

import { boxArt, cardArt } from "@/kit/placeholder-art"
import { PLATFORMS } from "@/design/platforms"
import { DEMO_CARDS, DEMO_GAMES } from "@/lib/api/fixtures"
import { formatDate } from "@/lib/dates"
import {
  DEMO_CUSTOMERS,
  demoCreditLedgerFor,
  findDemoCustomer,
} from "@/lib/api/demo/customers"
import {
  demoCreateDraft,
  demoGetLines,
  demoSaveLines,
  demoTradeIns,
  demoTradeInsFor,
} from "@/lib/api/demo/tradeins"
import { ensureSeeded, itemStore } from "@/lib/api/demo/store"
import {
  DEMO_PORTAL_CODE,
  DEMO_PORTAL_CUSTOMER_ID,
  DEMO_PORTAL_EMAIL,
  DEMO_PORTAL_NO_CREDIT_EMAIL,
  DEMO_PORTAL_NO_CREDIT_ID,
  demoPortalCustomerForEmail,
  demoPortalCustomerId,
  setDemoPortalCustomer,
} from "@/lib/api/demo/portal-seed"
import type {
  CardLanding,
  HoldRow,
  NewQuoteInput,
  NewWantInput,
  NotificationPage,
  NotificationRow,
  QuoteDetail,
  QuoteLine,
  QuoteMessage,
  QuoteQueueRow,
  QuoteRecord,
  StaffQuoteDetail,
  TradeInLineInput,
  VaultMe,
  VaultMePatch,
  VaultTradeIn,
  VaultTradeInDetail,
  WantListRow,
} from "@/lib/api/types"

/**
 * My Vault's demo shop, in memory.
 *
 * One signed-in customer, Jasmine Okafor, who is the same person the counter's
 * demo book already holds: the same record id, the same code and the same QR
 * token, so scanning her card at the demo counter and opening `/c/<token>` in
 * the demo portal land on one customer rather than two.
 *
 * Everything below is deterministic, so the e2e suite and the screenshot
 * script see the same figures on every run: one completed counter trade-in
 * and one that came in through a quote, a credit ledger that adds up to the
 * balance, two quotes in different states, a want list with one live hold,
 * and three notifications with two unread.
 *
 * Nothing is persisted. A reload starts the demo portal over.
 */

const DAY = 86_400_000
const HOUR = 3_600_000

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString()
}

function hoursAhead(hours: number): string {
  return new Date(Date.now() + hours * HOUR).toISOString()
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * HOUR).toISOString()
}

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

const CARD_ART = cardArt(PLATFORMS.tcg_card.ratio)
const BOX_ART = boxArt(PLATFORMS.snes_pal_box.ratio)


function seedCustomer() {
  return (
    findDemoCustomer(demoPortalCustomerId()) ??
    findDemoCustomer(DEMO_PORTAL_CUSTOMER_ID) ??
    DEMO_CUSTOMERS[0] ??
    null
  )
}

export {
  DEMO_PORTAL_CODE,
  DEMO_PORTAL_CUSTOMER_ID,
  DEMO_PORTAL_EMAIL,
  DEMO_PORTAL_NO_CREDIT_EMAIL,
  DEMO_PORTAL_NO_CREDIT_ID,
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/** Set by `demoRequestCode`, so the code step cannot be reached cold. */
let pendingEmail = ""

export function demoRequestCode(email: string): { otpId: string } {
  const clean = email.trim().toLowerCase()
  if (!clean.includes("@")) {
    throw new Error("That does not look like an email address. Check it and try again.")
  }
  pendingEmail = clean
  return { otpId: "demo-otp" }
}

export function demoSignIn(code: string): VaultMe {
  if (code !== DEMO_PORTAL_CODE) {
    throw new Error("That code does not match. Check it, or send another.")
  }
  const id = demoPortalCustomerForEmail(pendingEmail)
  if (!id) {
    throw new Error(
      "We have no card on that email address. Ask at the counter and we will add it."
    )
  }
  setDemoPortalCustomer(id)
  return demoMe()
}

// ---------------------------------------------------------------------------
// Me
// ---------------------------------------------------------------------------

/** One preference pair per demo card, both on by default as the server's are. */
const preferences: Record<string, { email: boolean; push: boolean }> = {}

function preferencesFor(id: string) {
  if (!preferences[id]) preferences[id] = { email: true, push: true }
  return preferences[id]
}

export function demoMe(): VaultMe {
  const entry = seedCustomer()
  if (!entry) throw new Error("The demo shop has no customers.")
  const credit = demoCreditLedgerFor(entry.customer.id).reduce(
    (sum, row) => sum + row.amount,
    0
  )
  return {
    customer: {
      id: entry.customer.id,
      code: entry.customer.code,
      name: entry.customer.name,
      email: entry.customer.email ?? "",
      phone: entry.customer.phone ?? "",
      marketing_consent: entry.customer.marketing_consent ?? false,
      birthday_month: entry.customer.birthday_month ?? null,
      qr_token: entry.customer.qr_token ?? "",
      created: entry.customer.created ?? daysAgo(412),
      notifications: { ...preferencesFor(entry.customer.id) },
    },
    balances: { credit, points: entry.private.points_balance ?? 0 },
    // Tiers land in Phase 6. Until then the card reads "Member", which is
    // what the counter's own card prints when a customer has no tier row.
    tier: null,
    id_status: entry.private.id_status ?? "none",
    counts: {
      trade_ins: demoMyTradeIns().length,
      open_quotes: demoQuotes.filter(
        (quote) =>
          quote.customer === DEMO_PORTAL_CUSTOMER_ID &&
          ["submitted", "reviewing", "offered", "accepted", "received"].includes(
            quote.status
          )
      ).length,
      want_list: demoMyWants().length,
    },
    // No key in the demo shop, which is what an install that has not set
    // push up looks like: the Profile screen says so rather than offering a
    // switch that could never work.
    push: { vapid_public_key: "" },
  }
}

export function demoPatchMe(patch: VaultMePatch): VaultMe {
  const entry = seedCustomer()
  if (!entry) throw new Error("The demo shop has no customers.")
  if (patch.name !== undefined) entry.customer.name = patch.name
  if (patch.phone !== undefined) entry.customer.phone = patch.phone || undefined
  if (patch.marketing_consent !== undefined) {
    entry.customer.marketing_consent = patch.marketing_consent
  }
  if (patch.birthday_month !== undefined) {
    entry.customer.birthday_month = patch.birthday_month ?? undefined
  }
  if (patch.notifications) {
    const prefs = preferencesFor(entry.customer.id)
    prefs.email = patch.notifications.email
    prefs.push = patch.notifications.push
  }
  return demoMe()
}

export function demoExport(): Record<string, unknown> {
  const me = demoMe()
  return {
    exported_at: new Date().toISOString(),
    customer: me.customer,
    balances: me.balances,
    id_status: me.id_status,
    trade_ins: demoMyTradeIns().map((entry) => demoMyTradeIn(entry.id)),
    credit_ledger: demoCreditLedgerFor(me.customer.id),
    // The real export sends every quote without its `photos` field, and
    // carries no message thread at all (docs/api-contract.md, Phase 5).
    quotes: demoListQuotes(),
    want_list: demoMyWants(),
    notifications: demoMyNotifications(),
  }
}

export function demoDeleteAccount(): { erased: true } {
  const me = demoMe()
  if (me.balances.credit > 0) {
    throw new Error(
      `You still have ${formatGBP(me.balances.credit)} store credit. Use it or ask the shop to pay it out first.`
    )
  }
  return { erased: true }
}

export function demoCardLanding(token: string): CardLanding {
  const known = DEMO_CUSTOMERS.some((entry) => entry.customer.qr_token === token)
  if (!known) throw new Error("That card is not one of ours.")
  return { known: true }
}

// ---------------------------------------------------------------------------
// Trade-ins and store credit
// ---------------------------------------------------------------------------

/**
 * The remote buy-in the completed quote below turned into. The counter's own
 * demo book holds Jasmine's counter trade-in; this is the one that arrived
 * through the portal, so My Vault shows both routes into the shop.
 */
const REMOTE_TRADE_IN: VaultTradeInDetail = {
  id: "trade_demo_portal",
  number: "GG-BI-000061",
  status: "completed",
  at: daysAgo(38),
  payoutType: "cash",
  payoutCash: 4200,
  payoutCredit: 0,
  totalOffer: 4200,
  lines: [
    {
      id: "trade_demo_portal_l1",
      title: "Pidgeot ex 113/191",
      detail: "Near mint, holo",
      qty: 1,
      offerPrice: 2600,
    },
    {
      id: "trade_demo_portal_l2",
      title: "Super Mario World, boxed",
      detail: "Boxed, complete",
      qty: 1,
      offerPrice: 1600,
    },
  ],
}

function summarise(entry: VaultTradeIn): VaultTradeIn {
  return {
    id: entry.id,
    number: entry.number,
    status: entry.status,
    at: entry.at,
    payoutType: entry.payoutType,
    payoutCash: entry.payoutCash,
    payoutCredit: entry.payoutCredit,
    totalOffer: entry.totalOffer,
  }
}

export function demoMyTradeIns(): VaultTradeIn[] {
  if (demoPortalCustomerId() !== DEMO_PORTAL_CUSTOMER_ID) {
    // The second demo card has never sold us anything, which is what makes
    // its erasure path reachable.
    return []
  }
  const fromCounter = demoTradeInsFor(DEMO_PORTAL_CUSTOMER_ID)
    .filter((entry) => entry.status === "completed")
    .map(summarise)
  return [...fromCounter, summarise(REMOTE_TRADE_IN)].sort((a, b) =>
    b.at.localeCompare(a.at)
  )
}

export function demoMyTradeIn(id: string): VaultTradeInDetail {
  if (id === REMOTE_TRADE_IN.id) return REMOTE_TRADE_IN
  const summary = demoMyTradeIns().find((entry) => entry.id === id)
  if (!summary) throw new Error("That trade-in is not on your record.")
  return {
    ...summary,
    lines: demoGetLines(id).map((line) => ({
      id: line.id,
      title: line.free_text_title || "Item",
      detail: [line.condition, line.completeness].filter(Boolean).join(", "),
      qty: line.qty ?? 1,
      offerPrice: line.offer_price ?? 0,
    })),
  }
}

export function demoCreditLedger() {
  return demoCreditLedgerFor(demoPortalCustomerId())
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

// The record, but with the photos already resolved: the demo shop has no
// file store, so a photo is the art and its name rather than a file name on
// a record (`QuoteRecord.photos`, which the live collection read carries).
interface DemoQuote extends Omit<QuoteRecord, "photos"> {
  messages: QuoteMessage[]
  photos: { name: string; url: string }[]
}

export const demoQuotes: DemoQuote[] = [
  {
    // Nobody has picked this one up yet: the counter's queue opens on it.
    id: "quote_demo_3",
    customer: "cust_demo_2",
    status: "submitted",
    message:
      "Loft box from my brother. A stack of Pokemon holos and two Game Boy carts. What are they worth?",
    drop_off: "in_store",
    created: hoursAgo(5),
    messages: [
      {
        id: "quote_demo_3_m1",
        author: "customer",
        body: "Loft box from my brother. A stack of Pokemon holos and two Game Boy carts. What are they worth?",
        created: hoursAgo(5),
      },
    ],
    photos: [
      { name: "quote-4.jpg", url: CARD_ART },
      { name: "quote-5.jpg", url: BOX_ART },
      { name: "quote-6.jpg", url: CARD_ART },
      { name: "quote-7.jpg", url: BOX_ART },
    ],
  },
  {
    id: "quote_demo_1",
    customer: DEMO_PORTAL_CUSTOMER_ID,
    status: "offered",
    message: "Four holos and a boxed SNES game. Happy with credit if it is better.",
    drop_off: "in_store",
    created: daysAgo(3),
    offer_total: 4200,
    offer_expires_at: hoursAhead(96),
    lines: [
      {
        title: "Charizard ex 199/165",
        condition: "NM",
        finish: "holo",
        qty: 1,
        market_price: 32000,
        market_source: "Cardmarket",
        offer_price: 2600,
      },
      {
        title: "Super Mario World, boxed",
        qty: 1,
        market_price: 3200,
        market_source: "PriceCharting PAL",
        offer_price: 1600,
      },
    ],
    messages: [
      {
        id: "quote_demo_1_m1",
        author: "customer",
        body: "Four holos and a boxed SNES game. Happy with credit if it is better.",
        created: daysAgo(3),
      },
      {
        id: "quote_demo_1_m2",
        author: "staff",
        body: "Thanks, that is a nice lot. The Charizard looks near mint from the photo, so the offer assumes that. Bring it in and we will check it over.",
        created: daysAgo(1),
      },
    ],
    photos: [
      { name: "quote-1.jpg", url: CARD_ART },
      { name: "quote-2.jpg", url: BOX_ART },
    ],
  },
  {
    // Accepted and on its way: this is the one "Mark as received" turns
    // into a draft buy-in.
    id: "quote_demo_4",
    customer: "cust_demo_3",
    status: "accepted",
    message: "Two graded slabs and a Mega Drive boxed game. Posting them if you want them.",
    drop_off: "post",
    created: daysAgo(9),
    offer_total: 9000,
    offer_expires_at: hoursAhead(72),
    reply: "Yes please. I will post them on Monday.",
    customer_reply: "Yes please. I will post them on Monday.",
    lines: [
      {
        title: "Blastoise 2/102",
        condition: "LP",
        finish: "holo",
        qty: 1,
        market_price: 12000,
        market_source: "cardmarket",
        offer_price: 6000,
        // No card row behind it, so the offer carried its own kind and
        // game, exactly as the counter now sends them.
        kind: "graded",
        game: "game_pokemon",
      },
      {
        title: "Sonic the Hedgehog 2, boxed",
        condition: "cib",
        qty: 1,
        market_price: 6000,
        market_source: "pricecharting_pal",
        offer_price: 3000,
        kind: "retro",
        game: "game_retro",
      },
    ],
    messages: [
      {
        id: "quote_demo_4_m1",
        author: "customer",
        body: "Two graded slabs and a Mega Drive boxed game. Posting them if you want them.",
        created: daysAgo(9),
      },
      {
        id: "quote_demo_4_m2",
        author: "staff",
        body: "Offer sent. Post them to the shop and we will check them over when they land.",
        created: daysAgo(8),
      },
    ],
    photos: [
      { name: "quote-8.jpg", url: CARD_ART },
      { name: "quote-9.jpg", url: BOX_ART },
    ],
  },
  {
    id: "quote_demo_2",
    customer: DEMO_PORTAL_CUSTOMER_ID,
    status: "completed",
    message: "Bulk Pokemon, about 300 cards, plus two Game Boy carts.",
    drop_off: "in_store",
    created: daysAgo(44),
    offer_total: 4200,
    offer_expires_at: daysAgo(37),
    reply: "Yes please, I will bring them Saturday.",
    trade_in: REMOTE_TRADE_IN.id,
    lines: [
      {
        title: "Pidgeot ex 113/191",
        condition: "NM",
        qty: 1,
        market_price: 4800,
        market_source: "Cardmarket",
        offer_price: 2600,
      },
      {
        title: "Super Mario World, boxed",
        qty: 1,
        market_price: 3200,
        market_source: "PriceCharting PAL",
        offer_price: 1600,
      },
    ],
    messages: [
      {
        id: "quote_demo_2_m1",
        author: "customer",
        body: "Bulk Pokemon, about 300 cards, plus two Game Boy carts.",
        created: daysAgo(44),
      },
      {
        id: "quote_demo_2_m2",
        author: "staff",
        body: "Offer sent. It stands for seven days.",
        created: daysAgo(42),
      },
    ],
    photos: [{ name: "quote-3.jpg", url: CARD_ART }],
  },
]

/** The record half of a demo quote, without its thread or its photos. */
function toQuoteRecord(quote: DemoQuote): QuoteRecord {
  const { messages, photos, ...record } = quote
  void messages
  void photos
  return record
}

export function demoListQuotes(): QuoteRecord[] {
  // The signed-in customer's own quotes. The demo shop holds other
  // customers' quotes as well, because the counter's queue needs a queue;
  // My Vault has never shown anybody else's.
  return demoQuotes
    .filter((quote) => quote.customer === demoPortalCustomerId())
    .sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""))
    .map(toQuoteRecord)
}

function findQuote(id: string): DemoQuote {
  const quote = demoQuotes.find((entry) => entry.id === id)
  if (!quote) throw new Error("That quote is not on your record.")
  return quote
}

/**
 * The signed-in customer's own quote, or nothing.
 *
 * `GET /api/vault/quotes/:id` 404s a quote belonging to somebody else
 * rather than 403ing it, so a customer can never learn that another
 * customer's record exists. The demo shop holds several customers' quotes
 * now that the counter has a queue, so it has to say the same.
 */
function findOwnQuote(id: string): DemoQuote {
  const quote = demoQuotes.find(
    (entry) => entry.id === id && entry.customer === demoPortalCustomerId()
  )
  if (!quote) throw new Error("That quote is not on your record.")
  return quote
}

export function demoGetQuote(id: string): QuoteDetail {
  const { messages, photos, ...quote } = findOwnQuote(id)
  return {
    // Lines are spread too: the screen must never be handed the very array
    // the store keeps, or an offer edited in one place changes in another.
    quote: { ...quote, lines: quote.lines ? quote.lines.map((line) => ({ ...line })) : undefined },
    messages: messages.map((message) => ({ ...message })),
    photos: photos.map((photo) => ({ ...photo })),
  }
}

export function demoCreateQuote(input: NewQuoteInput): QuoteRecord {
  const id = randomId("quote")
  const created = new Date().toISOString()
  const quote: DemoQuote = {
    id,
    customer: demoPortalCustomerId(),
    status: "submitted",
    message: input.message,
    drop_off: input.dropOff,
    created,
    photo_count: input.photos.length,
    messages: input.message
      ? [{ id: `${id}_m1`, author: "customer", body: input.message, created }]
      : [],
    photos: input.photos.map((_photo, index) => ({
      name: `photo-${index + 1}.jpg`,
      url: CARD_ART,
    })),
  }
  demoQuotes.unshift(quote)
  return toQuoteRecord(quote)
}

export function demoQuoteMessage(id: string, body: string): QuoteMessage {
  const quote = findQuote(id)
  const message: QuoteMessage = {
    id: randomId("msg"),
    author: "customer",
    body,
    created: new Date().toISOString(),
  }
  quote.messages.push(message)
  return message
}

export function demoAnswerQuote(
  id: string,
  answer: "accept" | "decline",
  reply?: string
): QuoteRecord {
  const quote = findOwnQuote(id)
  if (quote.status !== "offered") {
    throw new Error("This offer is no longer open. Ask the shop for a new one.")
  }
  // Only before the expiry, in the route's own words. The hourly cron is
  // what eventually moves the record to `expired`, so an offer can be past
  // its time while it still reads as offered.
  if (quote.offer_expires_at && new Date(quote.offer_expires_at) <= new Date()) {
    throw new Error(
      `This offer expired on ${formatDate(quote.offer_expires_at)}. Ask for a new one.`
    )
  }
  quote.status = answer === "accept" ? "accepted" : "declined"
  if (reply) {
    quote.reply = reply
    quote.messages.push({
      id: randomId("msg"),
      author: "customer",
      body: reply,
      created: new Date().toISOString(),
    })
  }
  return toQuoteRecord(quote)
}

// ---------------------------------------------------------------------------
// Want list
// ---------------------------------------------------------------------------

interface DemoWant extends WantListRow {
  customer: string
}

export const demoWants: DemoWant[] = [
  {
    id: "want_demo_1",
    customer: DEMO_PORTAL_CUSTOMER_ID,
    title: "Charizard ex",
    subtitle: "Scarlet & Violet 151 - 199/165",
    image: CARD_ART,
    maxPrice: 25000,
    status: "matched",
    hold: {
      until: hoursAhead(30),
      price: 23000,
      title: "Charizard ex 199/165",
    },
    created: daysAgo(12),
  },
  {
    id: "want_demo_2",
    customer: DEMO_PORTAL_CUSTOMER_ID,
    title: "Pidgeot ex",
    subtitle: "Surging Sparks - 113/191",
    image: CARD_ART,
    maxPrice: 4000,
    status: "open",
    hold: null,
    created: daysAgo(6),
  },
  {
    id: "want_demo_3",
    customer: DEMO_PORTAL_CUSTOMER_ID,
    title: "Pokemon Snap, boxed",
    subtitle: "Typed in by you",
    maxPrice: null,
    status: "open",
    hold: null,
    created: daysAgo(2),
  },
]

/** The signed-in card's own open rows. */
function demoMyWants(): DemoWant[] {
  return demoWants.filter(
    (row) => row.customer === demoPortalCustomerId() && row.status !== "closed"
  )
}

/**
 * Copies, not the stored rows.
 *
 * TanStack Query keeps the previous reference when a refetch is deeply equal
 * to what it already holds, so handing back the very objects the demo store
 * mutates would leave the screen showing the old state after a write. The
 * server sends fresh JSON every time; so does this.
 */
export function demoListWants(): WantListRow[] {
  return demoMyWants().map(({ customer, ...row }) => {
    void customer
    return { ...row, hold: row.hold ? { ...row.hold } : null }
  })
}

export function demoAddWant(
  input: NewWantInput,
  title: string,
  subtitle: string
): WantListRow {
  const row: DemoWant = {
    id: randomId("want"),
    customer: demoPortalCustomerId(),
    title,
    subtitle,
    image: input.cardId ? CARD_ART : undefined,
    maxPrice: input.maxPrice,
    status: "open",
    hold: null,
    created: new Date().toISOString(),
  }
  demoWants.unshift(row)
  const { customer, ...shape } = row
  void customer
  return shape
}

export function demoCloseWant(id: string) {
  const row = demoWants.find(
    (entry) => entry.id === id && entry.customer === demoPortalCustomerId()
  )
  if (!row) throw new Error("That row is not on your want list.")
  row.status = "closed"
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

interface DemoNotification extends NotificationRow {
  customer: string
}

export const demoNotifications: DemoNotification[] = [
  {
    id: "note_demo_1",
    customer: DEMO_PORTAL_CUSTOMER_ID,
    type: "want_match",
    title: "Charizard ex 199/165 is in",
    body: "Held for you until the time on your want list. Come and collect it.",
    link: "/account/want-list",
    created: daysAgo(1),
  },
  {
    id: "note_demo_2",
    customer: DEMO_PORTAL_CUSTOMER_ID,
    type: "quote_offer",
    title: "Your quote offer, £42.00",
    body: "We have priced the lot you sent. The offer stands for four more days.",
    link: "/account/quotes/quote_demo_1",
    created: daysAgo(1),
  },
  {
    id: "note_demo_3",
    customer: DEMO_PORTAL_CUSTOMER_ID,
    type: "trade_in",
    title: "Buy-in GG-BI-000061 completed",
    body: "£42.00 paid in cash. Thanks for bringing them in.",
    link: "/account/trade-ins/trade_demo_portal",
    read_at: daysAgo(37),
    created: daysAgo(38),
  },
]

/** The signed-in card's own rows, newest first. */
function demoMyNotifications(): NotificationRow[] {
  return demoNotifications
    .filter((row) => row.customer === demoPortalCustomerId())
    .map(({ customer, ...row }) => {
      void customer
      return { ...row }
    })
    .sort((a, b) => b.created.localeCompare(a.created))
}

export function demoListNotifications(): NotificationPage {
  const items = demoMyNotifications()
  return { items, unread: items.filter((row) => !row.read_at).length }
}

export function demoMarkNotificationRead(id: string) {
  const row = demoNotifications.find(
    (entry) => entry.id === id && entry.customer === demoPortalCustomerId()
  )
  if (row && !row.read_at) row.read_at = new Date().toISOString()
}

// ---------------------------------------------------------------------------
// The counter's side of the demo shop
//
// The same quotes, want-list holds and customers My Vault reads above, seen
// from behind the counter: one queue across every customer, the five staff
// actions on a quote, and the holds that run out today. One store, so a
// demo offer sent at the counter is the offer the portal then shows.
// ---------------------------------------------------------------------------

function demoCustomerFor(id: string) {
  return findDemoCustomer(id)?.customer ?? null
}

/** The whole queue, newest first, exactly as the collection read returns it. */
export function demoQuoteQueue(): QuoteQueueRow[] {
  return [...demoQuotes]
    .sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""))
    .map((quote) => {
      const customer = demoCustomerFor(quote.customer)
      return {
        id: quote.id,
        status: quote.status,
        customerId: quote.customer,
        customerName: customer?.name ?? "",
        customerCode: customer?.code ? displayCode(customer.code) : "",
        photoCount: quote.photos.length,
        message: quote.message ?? "",
        dropOff: quote.drop_off ?? null,
        offerTotal: quote.offer_total ?? null,
        offerExpiresAt: quote.offer_expires_at ?? null,
        created: quote.created ?? "",
      }
    })
}

export function demoStaffQuote(id: string): StaffQuoteDetail {
  const { messages, photos, ...quote } = findQuote(id)
  const customer = demoCustomerFor(quote.customer)
  return {
    quote,
    messages: [...messages],
    photos: [...photos],
    customer: customer
      ? {
          id: customer.id,
          name: customer.name,
          code: displayCode(customer.code),
          email: customer.email ?? "",
        }
      : null,
    tradeInId: demoTradeInForQuote(id),
  }
}

/** The buy-in a received demo quote became, by the link the route writes. */
export function demoTradeInForQuote(id: string): string | null {
  const quote = demoQuotes.find((entry) => entry.id === id)
  return quote?.trade_in ?? null
}

export function demoQuoteReviewing(id: string): QuoteRecord {
  const quote = findQuote(id)
  if (quote.status !== "submitted") {
    throw new Error(`This quote is ${quote.status} and cannot be picked up now.`)
  }
  quote.status = "reviewing"
  return toQuoteRecord(quote)
}

export function demoStaffQuoteMessage(id: string, body: string): QuoteMessage {
  const quote = findQuote(id)
  const message: QuoteMessage = {
    id: randomId("msg"),
    author: "staff",
    body,
    created: new Date().toISOString(),
  }
  quote.messages.push(message)
  return message
}

/** The offer, with the total recomputed from the lines as the route does. */
export function demoSendQuoteOffer(
  id: string,
  lines: QuoteLine[],
  message?: string
): QuoteRecord {
  const quote = findQuote(id)
  if (quote.status !== "submitted" && quote.status !== "reviewing") {
    throw new Error(`This quote is ${quote.status} and cannot be offered on.`)
  }
  const now = new Date()
  const expires = new Date(now.getTime() + 7 * DAY)
  quote.lines = lines.map((line) => ({ ...line }))
  quote.offer_total = lines.reduce(
    (sum, line) => sum + line.offer_price * line.qty,
    0
  )
  quote.offer_expires_at = expires.toISOString()
  quote.status = "offered"
  if (message?.trim()) {
    quote.messages.push({
      id: randomId("msg"),
      author: "staff",
      body: message.trim(),
      created: now.toISOString(),
    })
  }
  return toQuoteRecord(quote)
}

/**
 * The items have arrived: a draft buy-in with the quote's lines on it, and
 * the quote marked received. The same two steps the route takes, so the
 * wizard opens on a real draft in demo mode too.
 */
export function demoQuoteReceived(id: string): {
  trade_in_id: string
  number: string
} {
  const quote = findQuote(id)
  if (quote.status !== "accepted") {
    throw new Error(`This quote is ${quote.status}, not ready to receive.`)
  }

  // The route's own rules, to the letter: a line's kind is what the offer
  // set, or `single` for a card, `retro` for a retro title, `other` for
  // anything else; its game is what the offer set, or the card's own game,
  // or the retro game. A line with none of the three is refused here rather
  // than written as a draft line the completion route could never price.
  const retroGameId = DEMO_GAMES.find((game) => game.key === "retro")?.id ?? ""
  const lines = (quote.lines ?? []).map((line, at) => {
    const card = line.card ? DEMO_CARDS.find((row) => row.id === line.card) : undefined
    const kind =
      line.kind || (line.card ? "single" : line.retro_title ? "retro" : "other")
    const gameId =
      line.game || card?.gameId || (kind === "retro" ? retroGameId : "")
    if (!gameId) {
      throw new Error(
        `Line ${at + 1} has no game set. Add a game to the offer line and try again.`
      )
    }
    return {
      kind: kind as TradeInLineInput["kind"],
      gameId,
      title: line.title,
      cardId: line.card,
      retroTitleId: line.retro_title,
      finish: line.finish,
      condition: line.condition,
      qty: line.qty,
      marketPrice: line.market_price,
      marketSource: line.market_source ?? "",
      offerPrice: line.offer_price,
      accepted: true,
    }
  })

  const draft = demoCreateDraft(quote.customer)
  const entry = demoTradeIns.find((row) => row.record.id === draft.id)
  if (entry) entry.record.channel = "remote"
  demoSaveLines(draft.id, lines)
  quote.status = "received"
  quote.trade_in = draft.id
  return { trade_in_id: draft.id, number: draft.number }
}

export function demoCancelQuote(id: string, note: string): QuoteRecord {
  const quote = findQuote(id)
  if (["declined", "expired", "completed", "received"].includes(quote.status)) {
    throw new Error(`This quote is already ${quote.status}.`)
  }
  quote.status = "declined"
  quote.staff_note = note
  quote.messages.push({
    id: randomId("msg"),
    author: "staff",
    body: note,
    created: new Date().toISOString(),
  })
  return toQuoteRecord(quote)
}

/**
 * The holds running out today, soonest first.
 *
 * Read from the demo item store rather than the want list, the same way the
 * live call reads `items`: a hold is a reserved item whoever put it there.
 */
export function demoHoldsEndingToday(now: Date = new Date()): HoldRow[] {
  ensureSeeded()
  const end = new Date(now)
  end.setHours(23, 59, 59, 999)
  return itemStore()
    .filter(
      (item) =>
        item.status === "reserved" &&
        Boolean(item.reserved_until) &&
        new Date(item.reserved_until as string).getTime() <= end.getTime()
    )
    .sort((a, b) => (a.reserved_until ?? "").localeCompare(b.reserved_until ?? ""))
    .map((item) => {
      const customer = demoCustomerFor(item.reserved_for ?? "")
      return {
        itemId: item.id,
        sku: item.sku,
        title: item.title || "Item",
        price: item.price ?? 0,
        customerId: item.reserved_for ?? "",
        customerName: customer?.name ?? "",
        customerCode: customer?.code ? displayCode(customer.code) : "",
        until: item.reserved_until ?? "",
      }
    })
}
