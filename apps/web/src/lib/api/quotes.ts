/**
 * Remote quotes: send photos, watch the status, answer the offer, talk to
 * the shop.
 *
 * The Phase 5 route list has no "list my quotes" route, so the list is a
 * collection-API read of the customer's own rows, sorted newest first; every
 * other call is one of the custom routes. Photos are downscaled and stripped
 * before they are put in the form (see `features/portal/quote-photos.ts`),
 * never here.
 */
import { customerAuthId, pbCustomer } from "@/lib/pb-customer"
import { isDemo } from "@/lib/api/mode"
import {
  demoAnswerQuote,
  demoCreateQuote,
  demoGetQuote,
  demoListQuotes,
  demoQuoteMessage,
} from "@/lib/api/demo/portal"
import type {
  NewQuoteInput,
  QuoteDetail,
  QuoteMessage,
  QuoteRecord,
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
