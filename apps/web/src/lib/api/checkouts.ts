/**
 * The Solo card reader: the paired readers, and one checkout per sale.
 *
 * Phase 7 contract, section 1. SumUp takes the money and GG Vault records
 * the sale, exactly as before; what changes is that the amount goes to the
 * reader from here instead of being keyed into the SumUp app by hand.
 *
 * Not re-exported from `lib/api/index.ts` on purpose: that barrel travels in
 * the entry chunk, and this belongs to the Sell screen and the Settings
 * screen alone.
 */
import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { noteNetworkSuccess } from "@/lib/offline/net"
import * as demo from "@/lib/api/demo/checkouts"
import type {
  CreateCheckoutInput,
  SumUpCheckout,
  SumUpReader,
  SumUpReaderList,
} from "@/lib/api/types"

function toReader(row: Partial<SumUpReader> | undefined): SumUpReader {
  return {
    id: row?.id ?? "",
    name: row?.name ?? "Card reader",
    status: row?.status ?? "unknown",
    model: row?.model ?? "",
  }
}

function toCheckout(row: Partial<SumUpCheckout> | undefined): SumUpCheckout {
  return {
    id: row?.id ?? "",
    status: row?.status ?? "pending",
    amount: row?.amount ?? 0,
    reader_name: row?.reader_name ?? "",
    client_transaction_id: row?.client_transaction_id ?? "",
    transaction_code: row?.transaction_code ?? "",
    card_last4: row?.card_last4 ?? "",
    error: row?.error ?? "",
    paid_at: row?.paid_at ?? "",
    created: row?.created ?? "",
  }
}

/**
 * The readers SumUp says are paired, live.
 *
 * A shop with no merchant code or no key gets an empty list and
 * `not_configured`, never an error: the Sell screen says nothing at all in
 * that case, because a shop that has not set SumUp up does not need telling
 * on every sale.
 */
export async function listReaders(): Promise<SumUpReaderList> {
  if (isDemo()) return demo.listReaders()
  const result = await pb.send<Partial<SumUpReaderList>>("/api/vault/sumup/readers", {
    method: "GET",
  })
  noteNetworkSuccess()
  return {
    readers: (result.readers ?? []).map(toReader),
    default_reader_id: result.default_reader_id ?? "",
    not_configured: result.not_configured === true,
  }
}

/** Admin: the eight or nine characters off the Solo's Connections > API menu. */
export async function pairReader(
  pairingCode: string,
  name?: string
): Promise<SumUpReader> {
  if (isDemo()) return demo.pairReader(pairingCode, name)
  const result = await pb.send<{ reader?: Partial<SumUpReader> }>(
    "/api/vault/sumup/readers",
    { method: "POST", body: name ? { pairing_code: pairingCode, name } : { pairing_code: pairingCode } }
  )
  noteNetworkSuccess()
  return toReader(result.reader)
}

/** Admin: unpairs at SumUp and clears the default when it was this one. */
export async function removeReader(id: string): Promise<void> {
  if (isDemo()) {
    demo.removeReader(id)
    return
  }
  await pb.send(`/api/vault/sumup/readers/${id}`, { method: "DELETE" })
  noteNetworkSuccess()
}

export async function createCheckout(
  input: CreateCheckoutInput
): Promise<SumUpCheckout> {
  if (isDemo()) return demo.createCheckout(input)
  const result = await pb.send<{ checkout?: Partial<SumUpCheckout> }>(
    "/api/vault/sumup/checkouts",
    {
      method: "POST",
      body: {
        amount: input.amount,
        sale_client_id: input.saleClientId,
        ...(input.description ? { description: input.description } : {}),
        ...(input.readerId ? { reader_id: input.readerId } : {}),
      },
    }
  )
  noteNetworkSuccess()
  return toCheckout(result.checkout)
}

/**
 * Where the payment has got to.
 *
 * The server checks with SumUp itself when the row is still pending and more
 * than a few seconds old, so a callback lost on the way back never strands a
 * sale at the counter.
 */
export async function getCheckout(id: string): Promise<SumUpCheckout> {
  if (isDemo()) return demo.getCheckout(id)
  const result = await pb.send<{ checkout?: Partial<SumUpCheckout> }>(
    `/api/vault/sumup/checkouts/${id}`,
    { method: "GET" }
  )
  noteNetworkSuccess()
  return toCheckout(result.checkout)
}

/**
 * Stops the reader waiting. A customer who paid in the same second is not
 * cancelled: the server answers 409 and the row stays paid, because the
 * money is real and the sale still has to be completed.
 */
export async function cancelCheckout(id: string): Promise<SumUpCheckout> {
  if (isDemo()) return demo.cancelCheckout(id)
  const result = await pb.send<{ checkout?: Partial<SumUpCheckout> }>(
    `/api/vault/sumup/checkouts/${id}/cancel`,
    { method: "POST", body: {} }
  )
  noteNetworkSuccess()
  return toCheckout(result.checkout)
}

/**
 * Follows one checkout row, so a payment taken on the reader reaches the
 * till the moment SumUp calls back. The waiting sheet polls underneath this
 * every three seconds, so a socket that never connects costs a moment, not
 * the sale.
 */
export function subscribeCheckout(
  id: string,
  onChange: (checkout: SumUpCheckout) => void
): () => void {
  if (isDemo()) return demo.subscribeCheckout(id, onChange)

  let live = true
  let unsubscribe: (() => void) | null = null

  void pb
    .collection("sumup_checkouts")
    .subscribe<Partial<SumUpCheckout>>(id, (event) => {
      if (live) onChange(toCheckout(event.record))
    })
    .then((stop) => {
      if (!live) {
        void stop()
        return
      }
      unsubscribe = stop
    })
    .catch(() => {
      // The poll is the fallback, and it is already running.
    })

  return () => {
    live = false
    if (unsubscribe) void unsubscribe()
  }
}
