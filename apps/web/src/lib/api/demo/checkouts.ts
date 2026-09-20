/**
 * The demo shop's card reader.
 *
 * One Solo paired on the counter, which takes about a second and a half to
 * answer, exactly as the real one does while the customer taps. The demo is
 * where the waiting sheet is looked at and end-to-end tested, so both
 * endings have to be reachable: `localStorage` key `gg-demo-reader` decides
 * which. "fail" declines the card, "unpaired" takes the reader away and
 * "off" is a shop that has not set SumUp up at all.
 *
 * Nothing here is a record. It lives for the tab, like every other demo
 * store, and no money moves anywhere.
 */
import { demoSaveSettings, demoSettings } from "@/lib/api/demo/settings"
import type {
  CreateCheckoutInput,
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

const readers: SumUpReader[] = [
  { id: "reader_demo_1", name: "Counter Solo", status: "paired", model: "Solo" },
]

const checkouts = new Map<string, SumUpCheckout>()
const timers = new Map<string, number>()
const listeners = new Map<string, Set<(checkout: SumUpCheckout) => void>>()

let sequence = 0

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

/**
 * One checkout per sale: a second press while the first is still pending
 * finds that one rather than sending the customer a second amount.
 */
export function createCheckout(input: CreateCheckoutInput): SumUpCheckout {
  if (mode() === "off") {
    throw new Error(
      "SumUp is not set up. Add the merchant code and API key under Settings."
    )
  }
  if (mode() === "unpaired") {
    throw new Error("No card reader is paired. Pair one under Settings.")
  }
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new Error("The card part of this sale is not an amount the reader can take.")
  }

  const open = [...checkouts.values()].find(
    (row) => row.status === "pending" && row.id.endsWith(input.saleClientId)
  )
  if (open) return { ...open }

  const checkout: SumUpCheckout = {
    // The sale's key is in the id, so the idempotent lookup above needs no
    // second index for what is a handful of rows in a demo.
    id: `checkout_${input.saleClientId}`,
    status: "pending",
    amount: input.amount,
    reader_name: readerName(input.readerId),
    client_transaction_id: `demo-${input.saleClientId}`,
    transaction_code: "",
    card_last4: "",
    error: "",
    paid_at: "",
    created: new Date().toISOString(),
  }
  checkouts.set(checkout.id, checkout)

  const timer = window.setTimeout(() => {
    timers.delete(checkout.id)
    const row = checkouts.get(checkout.id)
    if (!row || row.status !== "pending") return
    if (mode() === "fail") {
      settle({
        ...row,
        status: "failed",
        error: "The card was declined. Ask for another card, or take the payment another way.",
      })
      return
    }
    settle({
      ...row,
      status: "paid",
      transaction_code: `TEHY${String(9000 + checkouts.size)}`,
      card_last4: "4242",
      paid_at: new Date().toISOString(),
    })
  }, ANSWER_MS)
  timers.set(checkout.id, timer)

  return { ...checkout }
}

function settle(checkout: SumUpCheckout) {
  checkouts.set(checkout.id, checkout)
  announce(checkout)
}

export function getCheckout(id: string): SumUpCheckout {
  const row = checkouts.get(id)
  if (!row) throw new Error("That payment is no longer on the reader. Take it again.")
  return { ...row }
}

export function cancelCheckout(id: string): SumUpCheckout {
  const row = checkouts.get(id)
  if (!row) throw new Error("That payment is no longer on the reader. Take it again.")
  if (row.status === "paid") {
    throw new Error("The customer already paid. Complete the sale.")
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
