/**
 * The demo shop's card reader.
 *
 * One Solo paired on the counter, which takes about a second and a half to
 * answer, exactly as the real one does while the customer taps. The demo is
 * where the waiting sheet is looked at and end-to-end tested, so every
 * ending has to be reachable: `localStorage` key `gg-demo-reader` decides
 * which. "fail" declines the card, "busy" is a reader already taking
 * somebody else's payment, "noref" is SumUp answering without a reference,
 * "unpaired" takes the reader away and "off" is a shop that has not set
 * SumUp up at all.
 *
 * The idempotency rule is the server's, word for word: one checkout per
 * `sale_client_id`, and asking again for a basket that has already paid
 * hands back the paid checkout with `reused`, never a second amount on the
 * reader and never a paid row overwritten.
 *
 * Nothing here is a record. It lives for the tab, like every other demo
 * store, and no money moves anywhere.
 */
import { ClientResponseError } from "pocketbase"

import { demoSaveSettings, demoSettings } from "@/lib/api/demo/settings"
import type {
  CreateCheckoutInput,
  CreateCheckoutResult,
  SumUpCheckout,
  SumUpReader,
  SumUpReaderList,
} from "@/lib/api/types"

const MODE_KEY = "gg-demo-reader"

/** About as long as a contactless tap takes to come back. */
const ANSWER_MS = 1500

function mode(): string {
  try {
    return localStorage.getItem(MODE_KEY) ?? ""
  } catch {
    return ""
  }
}

/** The shape a route refusal arrives in, so the screens read the demo alike. */
function refusal(status: number, message: string, extra: object = {}): never {
  throw new ClientResponseError({
    status,
    response: { code: status, message, data: {}, ...extra },
  })
}

const readers: SumUpReader[] = [
  { id: "reader_demo_1", name: "Counter Solo", status: "paired", model: "Solo" },
]

const checkouts = new Map<string, SumUpCheckout>()
const timers = new Map<string, number>()
const listeners = new Map<string, Set<(checkout: SumUpCheckout) => void>>()

let sequence = 0
let payments = 0

function announce(checkout: SumUpCheckout) {
  for (const listener of listeners.get(checkout.id) ?? []) listener({ ...checkout })
}

function defaultReaderId(): string {
  return demoSettings().sumup?.default_reader_id ?? ""
}

function setDefaultReader(reader: SumUpReader | null) {
  const current = demoSettings().sumup ?? {}
  demoSaveSettings({
    sumup: {
      ...current,
      default_reader_id: reader?.id ?? "",
      default_reader_name: reader?.name ?? "",
    },
  })
}

export function listReaders(): SumUpReaderList {
  if (mode() === "off") {
    return { readers: [], default_reader_id: "", not_configured: true }
  }
  if (mode() === "unpaired") {
    return { readers: [], default_reader_id: "", not_configured: false }
  }
  return {
    readers: readers.map((reader) => ({ ...reader })),
    default_reader_id: defaultReaderId() || readers[0]?.id || "",
    not_configured: false,
  }
}

/** The code on the Solo is eight or nine characters and lasts five minutes. */
export function pairReader(pairingCode: string, name?: string): SumUpReader {
  const code = pairingCode.trim()
  if (code.length < 8 || code.length > 9) {
    throw new Error(
      "That pairing code was not accepted. Read the code off the reader again; it changes each time."
    )
  }
  sequence += 1
  const reader: SumUpReader = {
    id: `reader_demo_${sequence + 1}`,
    name: name?.trim() || `Reader ${sequence + 1}`,
    status: "paired",
    model: "Solo",
  }
  readers.push(reader)
  if (!defaultReaderId()) setDefaultReader(reader)
  return { ...reader }
}

export function removeReader(id: string): void {
  const at = readers.findIndex((reader) => reader.id === id)
  if (at >= 0) readers.splice(at, 1)
  if (defaultReaderId() === id) setDefaultReader(readers[0] ?? null)
}

function readerName(id?: string): string {
  const wanted = id || defaultReaderId()
  return (
    readers.find((reader) => reader.id === wanted)?.name ??
    readers[0]?.name ??
    "Card reader"
  )
}

/** The basket's own open or paid-and-unused payment, if it has one. */
function forBasket(saleClientId: string): SumUpCheckout | null {
  for (const row of checkouts.values()) {
    if (row.sale_client_id !== saleClientId) continue
    if (row.status === "pending") return row
    if (row.status === "paid" && !row.sale) return row
  }
  return null
}

/**
 * One checkout per basket: a second press while the first is on the reader,
 * or after it has been paid and before a sale has used it, finds that one
 * rather than sending the customer a second amount.
 */
export function createCheckout(input: CreateCheckoutInput): CreateCheckoutResult {
  if (mode() === "off") {
    refusal(
      422,
      "SumUp is not set up. Add the merchant code and API key under Settings."
    )
  }
  if (mode() === "unpaired") {
    refusal(422, "No card reader is paired. Pair one under Settings.")
  }
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    refusal(400, "The card part of this sale is not an amount the reader can take.")
  }
  if (!input.saleClientId) {
    refusal(400, "That sale has no id of its own, so the payment could not be tracked.")
  }

  const open = forBasket(input.saleClientId)
  if (open) return { checkout: { ...open }, reused: true }

  if (mode() === "busy") {
    refusal(
      409,
      "The reader is busy with another payment. Finish or cancel that one first."
    )
  }
  if (mode() === "noref") {
    refusal(
      502,
      "SumUp did not give that payment a reference, so it could not be tracked. Check the reader, and the SumUp app, before taking it again."
    )
  }

  sequence += 1
  const checkout: SumUpCheckout = {
    id: `checkout_demo_${sequence}`,
    status: "pending",
    amount: input.amount,
    sale_client_id: input.saleClientId,
    description: input.description ?? "",
    reader_id: input.readerId || defaultReaderId(),
    reader_name: readerName(input.readerId),
    checkout_id: `sumup_checkout_${sequence}`,
    client_transaction_id: `demo-ctx-${sequence}`,
    transaction_id: "",
    transaction_code: "",
    card_last4: "",
    error: "",
    paid_at: "",
    sale: "",
    created: new Date().toISOString(),
  }
  checkouts.set(checkout.id, checkout)

  const timer = window.setTimeout(() => {
    timers.delete(checkout.id)
    const row = checkouts.get(checkout.id)
    // A row in a final state is never changed, however late an answer is.
    if (!row || row.status !== "pending") return
    if (mode() === "fail") {
      settle({
        ...row,
        status: "failed",
        error:
          "The card was declined. Ask for another card, or take the payment another way.",
      })
      return
    }
    payments += 1
    settle({
      ...row,
      status: "paid",
      transaction_id: `demo-txn-${payments}`,
      transaction_code: `TEHY${9000 + payments}`,
      card_last4: "4242",
      paid_at: new Date().toISOString(),
    })
  }, ANSWER_MS)
  timers.set(checkout.id, timer)

  return { checkout: { ...checkout }, reused: false }
}

function settle(checkout: SumUpCheckout) {
  checkouts.set(checkout.id, checkout)
  announce(checkout)
}

export function getCheckout(id: string): SumUpCheckout {
  const row = checkouts.get(id)
  if (!row) refusal(404, "That payment is no longer on the reader. Take it again.")
  return { ...row }
}

export function cancelCheckout(id: string): SumUpCheckout {
  const row = checkouts.get(id)
  if (!row) refusal(404, "That payment is no longer on the reader. Take it again.")
  if (row.status === "paid") {
    // The shape the route answers with: the refusal carries the checkout
    // that has just turned out to be paid.
    refusal(409, "The customer already paid. Complete the sale.", {
      checkout: { ...row },
    })
  }
  const timer = timers.get(id)
  if (timer) {
    window.clearTimeout(timer)
    timers.delete(id)
  }
  const cancelled: SumUpCheckout = { ...row, status: "cancelled" }
  settle(cancelled)
  return { ...cancelled }
}

/**
 * The sale side of the contract: a checkout must be paid, unused, and for
 * exactly the card part of the sale. The refusals are the route's own
 * sentences, so the Sell screen shows in demo what it shows at the counter.
 */
export function spendCheckoutOnSale(
  id: string,
  cardPart: number,
  sale: { id: string; number: string },
  formatMoney: (pence: number) => string
): SumUpCheckout {
  const row = checkouts.get(id)
  if (!row) {
    throw new Error(
      "That card payment was not found. Take the payment on the reader again."
    )
  }
  if (row.status !== "paid") {
    throw new Error(
      "That card payment is pending, not paid. Take the payment on the reader before completing the sale."
    )
  }
  if (row.sale) {
    const used = checkoutSaleNumber(row.sale)
    refusal(409, `That card payment has already been used on sale ${used}.`)
  }
  if (row.amount !== cardPart) {
    throw new Error(
      `The reader took ${formatMoney(row.amount)} but the card part of this sale is ${formatMoney(cardPart)}. Adjust the split or refund the difference from the SumUp app.`
    )
  }
  const used: SumUpCheckout = { ...row, sale: sale.id }
  checkouts.set(id, used)
  saleNumbers.set(sale.id, sale.number)
  return { ...used }
}

/** Sale ids to their numbers, so the already-used refusal can name one. */
const saleNumbers = new Map<string, string>()

function checkoutSaleNumber(saleId: string): string {
  return saleNumbers.get(saleId) ?? saleId
}

export function subscribeCheckout(
  id: string,
  onChange: (checkout: SumUpCheckout) => void
): () => void {
  const set = listeners.get(id) ?? new Set()
  set.add(onChange)
  listeners.set(id, set)
  return () => {
    set.delete(onChange)
    if (set.size === 0) listeners.delete(id)
  }
}
