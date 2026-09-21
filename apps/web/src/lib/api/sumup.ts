/**
 * SumUp: pull the day's card transactions, and put them beside the shop's
 * own card sales.
 *
 * The comparison is card takings against card takings. A mixed sale's card
 * share, not its total, is what reaches SumUp, so `card_share` is the figure
 * on both sides (docs/api-contract.md, "Phase 4: exports, imports and
 * SumUp"). Refunds, failed and pending transactions, and any transaction
 * whose amount could not be read, are stored on the server but appear in
 * neither list and in neither total.
 *
 * Nothing here writes a cash movement. Matching a transaction to a sale is a
 * comparison and a link, never a ledger entry.
 */
import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { noteNetworkSuccess } from "@/lib/offline/net"
import * as demo from "@/lib/api/demo/sumup"
import type { SumUpPullResult, SumUpReconcile } from "@/lib/api/types"

/** Fetch what SumUp has seen since the last pull. Admin only. */
export async function pullSumUp(): Promise<SumUpPullResult> {
  if (isDemo()) return demo.pull()
  const result = await pb.send<SumUpPullResult>("/api/vault/sumup/pull", {
    method: "POST",
  })
  noteNetworkSuccess()
  return {
    fetched: result.fetched ?? 0,
    matched: result.matched ?? 0,
    unmatched: result.unmatched ?? 0,
    refunded: result.refunded ?? 0,
  }
}

/** One day's transactions beside that day's card sales. */
export async function reconcileSumUp(date: string): Promise<SumUpReconcile> {
  if (isDemo()) return demo.reconcile(date)
  const result = await pb.send<SumUpReconcile>("/api/vault/sumup/reconcile", {
    method: "GET",
    query: { date },
  })
  noteNetworkSuccess()
  return result
}

/**
 * Tie a transaction to a sale by hand.
 *
 * There is no route for this in the contract: `sumup_transactions` is an
 * ordinary staff collection, so the link is the one field written straight
 * through the collection API. The next pull leaves an already-matched
 * transaction alone, so a hand-made match is never overwritten.
 */
export async function matchSumUpTransaction(
  transactionId: string,
  saleId: string
): Promise<void> {
  if (isDemo()) {
    demo.match(transactionId, saleId)
    return
  }
  await pb.collection("sumup_transactions").update(transactionId, {
    matched_sale: saleId,
  })
  noteNetworkSuccess()
}
