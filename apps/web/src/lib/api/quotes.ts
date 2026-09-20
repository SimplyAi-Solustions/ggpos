/**
 * Remote quotes, both sides of the counter: the customer sends photos,
 * watches the status, answers the offer and talks to the shop; staff work
 * the queue, price it into lines, offer, and turn an accepted quote into a
 * draft buy-in. The counter's own calls are in their own section below.
 *
 * The Phase 5 route list has no "list my quotes" route, so the list is a
 * collection-API read of the customer's own rows, sorted newest first; every
 * other call is one of the custom routes. Photos are downscaled and stripped
 * before they are put in the form (see `features/portal/quote-photos.ts`),
 * never here.
 */
import { displayCode } from "@gg/shared"

import { pb } from "@/lib/pb"
import { customerAuthId, pbCustomer } from "@/lib/pb-customer"
import { isDemo } from "@/lib/api/mode"
import { noteNetworkSuccess } from "@/lib/offline/net"
import {
  demoAnswerQuote,
  demoCancelQuote,
  demoCreateQuote,
  demoGetQuote,
  demoListQuotes,
  demoQuoteMessage,
  demoQuoteQueue,
  demoQuoteReceived,
  demoQuoteReviewing,
  demoSendQuoteOffer,
  demoStaffQuote,
  demoStaffQuoteMessage,
  demoTradeInForQuote,
} from "@/lib/api/demo/portal"
import type {
  NewQuoteInput,
  QuoteDetail,
  QuoteLine,
  QuoteMessage,
  QuoteQueueRow,
  QuoteRecord,
  QuoteStatus,
  StaffQuoteDetail,
} from "@/lib/api/types"

function escapeFilter(value: string): string {
  return value.replace(/["\\]/g, "\\$&")
}

export async function listMyQuotes(): Promise<QuoteRecord[]> {
  if (isDemo()) return demoListQuotes()
  const id = customerAuthId()
  if (!id) return []
  const page = await pbCustomer.collection("quotes").getList<QuoteRecord>(1, 50, {
    filter: `customer = "${escapeFilter(id)}"`,
    sort: "-created",
  })
  return page.items
}

export async function getQuote(id: string): Promise<QuoteDetail> {
  if (isDemo()) return demoGetQuote(id)
  return pbCustomer.send<QuoteDetail>(`/api/vault/quotes/${id}`, { method: "GET" })
}

/**
 * `POST /api/vault/quotes`, multipart.
 *
 * Every photo is already a downscaled JPEG by the time it gets here: the
 * screen will not enable the button until the pipeline has run, so nothing
 * with a GPS tag on it can reach the shop.
 */
export async function createQuote(input: NewQuoteInput): Promise<QuoteRecord> {
  if (isDemo()) return demoCreateQuote(input)

  const form = new FormData()
  input.photos.forEach((photo, index) => {
    form.append("photos", photo, `photo-${index + 1}.jpg`)
  })
  form.append("message", input.message)
  form.append("drop_off", input.dropOff)

  const result = await pbCustomer.send<{ quote: QuoteRecord }>(
    "/api/vault/quotes",
    { method: "POST", body: form }
  )
  return result.quote
}

export async function sendQuoteMessage(
  id: string,
  body: string
): Promise<QuoteMessage> {
  if (isDemo()) return demoQuoteMessage(id, body)
  const result = await pbCustomer.send<{ message: QuoteMessage }>(
    `/api/vault/quotes/${id}/messages`,
    { method: "POST", body: { body } }
  )
  return result.message
}

/** Accept or decline an offer, with an optional reply for the shop. */
export async function answerQuote(
  id: string,
  answer: "accept" | "decline",
  options: { reply?: string; dropOff?: "in_store" | "post" } = {}
): Promise<QuoteRecord> {
  if (isDemo()) return demoAnswerQuote(id, answer, options.reply)
  const body: Record<string, string> = {}
  if (options.reply) body.reply = options.reply
  if (options.dropOff) body.drop_off = options.dropOff
  const result = await pbCustomer.send<{ quote?: QuoteRecord } & QuoteRecord>(
    `/api/vault/quotes/${id}/${answer}`,
    { method: "POST", body }
  )
  // The route list does not name this response. Both shapes are accepted so
  // a wrapped `{ quote }` and a bare record both work.
  return result.quote ?? result
}

// ---------------------------------------------------------------------------
// The counter's own calls
//
// Everything above this line is My Vault's, on the customer client. The queue
// and the five staff actions below go through `pb`, the counter's own client,
// so a counter PC with a customer signed in on the same browser can still work
// the queue (the two clients keep separate tokens; see lib/pb-customer.ts).
//
// The custom routes are the same ones the portal calls where both sides may:
// `GET /api/vault/quotes/:id` takes either token. The queue itself has no
// route in the Phase 5 list, so it is a collection read of `quotes`, which is
// staff-readable end to end.
// ---------------------------------------------------------------------------

/** The statuses that are waiting on a member of staff to do something. */
export const QUOTES_WAITING: QuoteStatus[] = ["submitted", "reviewing"]

type ExpandedQuote = QuoteRecord & {
  expand?: { customer?: { id: string; name?: string; code?: string } }
}

function toQueueRow(record: ExpandedQuote): QuoteQueueRow {
  const customer = record.expand?.customer
  const photos = Array.isArray(record.photos) ? record.photos : []
  return {
    id: record.id,
    status: record.status ?? "submitted",
    customerId: record.customer,
    customerName: customer?.name ?? "",
    customerCode: customer?.code ? displayCode(customer.code) : "",
    photoCount: photos.length || record.photo_count || 0,
    message: record.message ?? "",
    dropOff: record.drop_off ?? null,
    offerTotal: record.offer_total ?? null,
    offerExpiresAt: record.offer_expires_at || null,
    created: record.created ?? "",
  }
}

/** The whole queue, newest first. The screen filters it by status. */
export async function listQuoteQueue(): Promise<QuoteQueueRow[]> {
  if (isDemo()) return demoQuoteQueue()
  const page = await pb.collection("quotes").getList<ExpandedQuote>(1, 100, {
    sort: "-created",
    expand: "customer",
  })
  noteNetworkSuccess()
  return page.items.map(toQueueRow)
}

/**
 * How many quotes are waiting on us, for the nav count and Home.
 *
 * A list of one: PocketBase returns `totalItems` for the whole filter, so
 * nothing but the count travels.
 */
export async function countQuotesWaiting(): Promise<number> {
  if (isDemo()) return demoQuoteQueue().filter((row) => QUOTES_WAITING.includes(row.status)).length
  const filter = QUOTES_WAITING.map((status) => `status = "${status}"`).join(" || ")
  const page = await pb.collection("quotes").getList(1, 1, { filter, fields: "id" })
  return page.totalItems
}

/**
 * One quote for the counter: the record, the thread, the tokenised photo
 * URLs, who sent it, and the buy-in it became if it has one.
 *
 * The customer and the trade-in are two small reads beside the route's own
 * answer rather than fields on it: `GET /api/vault/quotes/:id` returns the
 * quote record as it stands, and a counter screen needs the name to put at
 * the top of the page and somewhere to go once the items have arrived.
 */
export async function getStaffQuote(id: string): Promise<StaffQuoteDetail> {
  if (isDemo()) return demoStaffQuote(id)
  const detail = await pb.send<QuoteDetail>(`/api/vault/quotes/${id}`, {
    method: "GET",
  })
  const [customer, tradeInId] = await Promise.all([
    detail.quote.customer
      ? pb
          .collection("customers")
          .getOne<{ id: string; name?: string; code?: string; email?: string }>(
            detail.quote.customer
          )
          .catch(() => null)
      : Promise.resolve(null),
    findTradeInForQuote(id),
  ])
  return {
    ...detail,
    customer: customer
      ? {
          id: customer.id,
          name: customer.name ?? "",
          code: customer.code ? displayCode(customer.code) : "",
          email: customer.email ?? "",
        }
      : null,
    tradeInId,
  }
}

/**
 * The buy-in a received quote became, or null.
 *
 * `trade_ins.quote` is the link the received route writes, so this reads the
 * trade-in side: nothing is written back on to the quote.
 */
export async function findTradeInForQuote(id: string): Promise<string | null> {
  if (isDemo()) return demoTradeInForQuote(id)
  try {
    const record = await pb
      .collection("trade_ins")
      .getFirstListItem<{ id: string }>(`quote = "${escapeFilter(id)}"`, {
        fields: "id",
      })
    return record.id
  } catch {
    // No buy-in yet, which is every quote before it is received.
    return null
  }
}

/** `POST /api/vault/quotes/:id/reviewing`: somebody has picked this one up. */
export async function markQuoteReviewing(id: string): Promise<QuoteRecord> {
  if (isDemo()) return demoQuoteReviewing(id)
  const result = await pb.send<{ quote: QuoteRecord }>(
    `/api/vault/quotes/${id}/reviewing`,
    { method: "POST", body: {} }
  )
  return result.quote
}

/** The counter's side of the thread. The customer is emailed and pushed. */
export async function sendStaffQuoteMessage(
  id: string,
  body: string
): Promise<QuoteMessage> {
  if (isDemo()) return demoStaffQuoteMessage(id, body)
  const result = await pb.send<{ message: QuoteMessage }>(
    `/api/vault/quotes/${id}/messages`,
    { method: "POST", body: { body } }
  )
  return result.message
}

/**
 * `POST /api/vault/quotes/:id/offer`.
 *
 * The total is not sent: the route recomputes it from the lines every time,
 * so the figure on the offer is always the sum of what is on it.
 */
export async function sendQuoteOffer(
  id: string,
  lines: QuoteLine[],
  message?: string
): Promise<QuoteRecord> {
  if (isDemo()) return demoSendQuoteOffer(id, lines, message)
  const body: Record<string, unknown> = { lines }
  if (message?.trim()) body.message = message.trim()
  const result = await pb.send<{ quote: QuoteRecord }>(
    `/api/vault/quotes/${id}/offer`,
    { method: "POST", body }
  )
  return result.quote
}

/**
 * `POST /api/vault/quotes/:id/received`: the items are on the counter.
 *
 * Creates the draft buy-in with the quote's lines copied on to it and marks
 * the quote received. `number` comes back empty on purpose: a draft has no
 * number until it completes.
 */
export async function markQuoteReceived(
  id: string
): Promise<{ trade_in_id: string; number: string }> {
  if (isDemo()) return demoQuoteReceived(id)
  return pb.send<{ trade_in_id: string; number: string }>(
    `/api/vault/quotes/${id}/received`,
    { method: "POST", body: {} }
  )
}

/** `POST /api/vault/quotes/:id/cancel`. The note is required and is sent on. */
export async function cancelQuote(id: string, note: string): Promise<QuoteRecord> {
  if (isDemo()) return demoCancelQuote(id, note)
  const result = await pb.send<{ quote: QuoteRecord }>(
    `/api/vault/quotes/${id}/cancel`,
    { method: "POST", body: { note } }
  )
  return result.quote
}
