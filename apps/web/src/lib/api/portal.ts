/**
 * My Vault: the session, the customer's own record, their trade-ins and
 * their store credit.
 *
 * Every call here goes through `pbCustomer`, the portal's own PocketBase
 * client with its own auth store, so a staff session open in the same
 * browser is never disturbed. The custom routes are the ones in the Phase 5
 * list; the customer's own trade-ins and their credit ledger go through the
 * collection API, under the rules docs/api-contract.md's Phase 5 section
 * records for `trade_ins`, `trade_in_lines` and `credit_ledger`.
 */
import { ClientResponseError } from "pocketbase"

import { customerAuthId, pbCustomer } from "@/lib/pb-customer"
import { isDemo } from "@/lib/api/mode"
import {
  demoCardLanding,
  demoCreditLedger,
  demoDeleteAccount,
  demoExport,
  demoMe,
  demoMyTradeIn,
  demoMyTradeIns,
  demoPatchMe,
  demoRequestCode,
  demoSignIn,
} from "@/lib/api/demo/portal"
import type {
  CardLanding,
  CreditLedgerRecord,
  TradeInLineRecord,
  TradeInRecord,
  VaultMe,
  VaultMePatch,
  VaultTradeIn,
  VaultTradeInDetail,
} from "@/lib/api/types"
import { escapeFilter } from "@/lib/api/filter"


// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

/** A refusal written for the customer to read, not a stack trace. */
export class PortalSignInError extends Error {}

/**
 * Asks PocketBase to email a one-time code to this address.
 *
 * PocketBase answers with an `otpId` whether or not the address is on a card,
 * so nobody can use this to find out who shops here. A customer with no email
 * on file therefore reaches the code step and cannot get past it, which is
 * why the screen says to ask at the counter.
 */
export async function requestCode(email: string): Promise<string> {
  if (isDemo()) return demoRequestCode(email).otpId
  try {
    const result = await pbCustomer.collection("customers").requestOTP(email.trim())
    return result.otpId
  } catch (error) {
    throw new PortalSignInError(signInMessage(error))
  }
}

/** Exchanges the emailed code for a customer session. */
export async function signInWithCode(otpId: string, code: string): Promise<VaultMe> {
  if (isDemo()) return demoSignIn(code)
  try {
    await pbCustomer.collection("customers").authWithOTP(otpId, code)
  } catch (error) {
    throw new PortalSignInError(signInMessage(error))
  }
  return getMe()
}

/**
 * The sentence a failed sign-in shows.
 *
 * Exported for its own unit test: these are the words a customer reads when
 * the shop cannot be reached or the code has run out, and they are worth
 * pinning down.
 */
export function signInMessage(error: unknown): string {
  if (error instanceof ClientResponseError) {
    if (error.status === 400) {
      return "That code does not match, or it has run out. Send another."
    }
    if (error.status === 429) {
      return "Too many tries. Wait a minute and ask for another code."
    }
    const spoken = error.message?.trim()
    if (spoken && error.status < 500) return spoken
  }
  return "We could not reach the shop. Check your connection and try again."
}

// ---------------------------------------------------------------------------
// The customer's own record
// ---------------------------------------------------------------------------

export async function getMe(): Promise<VaultMe> {
  if (isDemo()) return demoMe()
  return pbCustomer.send<VaultMe>("/api/vault/me", { method: "GET" })
}

export async function updateMe(patch: VaultMePatch): Promise<VaultMe> {
  if (isDemo()) return demoPatchMe(patch)
  return pbCustomer.send<VaultMe>("/api/vault/me", { method: "PATCH", body: patch })
}

/**
 * "Download my data": the export route answers with a JSON attachment, so
 * this fetches it as a blob and hands the browser a download rather than
 * printing anybody's record into the page or into a log.
 */
export async function downloadMyData(): Promise<Blob> {
  if (isDemo()) {
    return new Blob([JSON.stringify(demoExport(), null, 2)], {
      type: "application/json",
    })
  }
  const response = await fetch(pbCustomer.buildURL("/api/vault/me/export"), {
    headers: { Authorization: pbCustomer.authStore.token },
  })
  if (!response.ok) {
    throw new Error("That download could not be prepared. Try again in a minute.")
  }
  return response.blob()
}

export async function deleteMyAccount(): Promise<{ erased: boolean }> {
  if (isDemo()) return demoDeleteAccount()
  const result = await pbCustomer.send<{ erased: boolean }>(
    "/api/vault/me/delete",
    { method: "POST" }
  )
  pbCustomer.authStore.clear()
  return result
}

/**
 * The QR landing, `GET /api/vault/c/:token`.
 *
 * Signed out it answers `{ known: true }` or 404, and never a name. Staff get
 * `{ customer_id, code, name }` and the owning customer gets their whole
 * `/me` shape; this screen needs neither, so any 200 at all means the token
 * belongs to a card and nothing else is read off the body.
 */
export async function getCardLanding(token: string): Promise<CardLanding> {
  if (isDemo()) return demoCardLanding(token)
  await pbCustomer.send(`/api/vault/c/${encodeURIComponent(token)}`, {
    method: "GET",
  })
  return { known: true }
}

// ---------------------------------------------------------------------------
// Trade-ins and store credit
// ---------------------------------------------------------------------------

function toVaultTradeIn(record: TradeInRecord): VaultTradeIn {
  return {
    id: record.id,
    number: record.number,
    status: record.status ?? "draft",
    at: record.completed_at ?? record.created ?? "",
    payoutType: record.payout_type ?? null,
    payoutCash: record.payout_cash ?? 0,
    payoutCredit: record.payout_credit ?? 0,
    totalOffer: record.total_offer ?? 0,
  }
}

/**
 * Every trade-in on the customer's record, newest first.
 *
 * Not only the completed ones: `counts.trade_ins` in the `/me` shape counts
 * every status, and a remote quote that has been accepted sits here as a
 * draft for days before it is paid. Filtering those out would have the card
 * screen and this list disagree about how many there are, and would hide the
 * one a customer is most likely to be looking for.
 */
export async function getMyTradeIns(): Promise<VaultTradeIn[]> {
  if (isDemo()) return demoMyTradeIns()
  const id = customerAuthId()
  if (!id) return []
  const page = await pbCustomer.collection("trade_ins").getList<TradeInRecord>(1, 50, {
    filter: `customer = "${escapeFilter(id)}"`,
    sort: "-created",
  })
  return page.items.map(toVaultTradeIn)
}

export async function getMyTradeIn(id: string): Promise<VaultTradeInDetail> {
  if (isDemo()) return demoMyTradeIn(id)
  const record = await pbCustomer.collection("trade_ins").getOne<TradeInRecord>(id)
  const lines = await pbCustomer
    .collection("trade_in_lines")
    .getFullList<TradeInLineRecord>({
      filter: `trade_in = "${escapeFilter(id)}"`,
      sort: "created",
    })
  return {
    ...toVaultTradeIn(record),
    lines: lines.map((line) => ({
      id: line.id,
      title: line.free_text_title || line.retro_title || "Item",
      detail: [line.condition, line.finish, line.completeness]
        .filter(Boolean)
        .join(", "),
      qty: line.qty ?? 1,
      offerPrice: line.offer_price ?? 0,
    })),
  }
}

export async function getMyCredit(): Promise<CreditLedgerRecord[]> {
  if (isDemo()) return demoCreditLedger()
  const id = customerAuthId()
  if (!id) return []
  return pbCustomer.collection("credit_ledger").getFullList<CreditLedgerRecord>({
    filter: `customer = "${escapeFilter(id)}"`,
    sort: "-created",
  })
}
