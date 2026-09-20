/**
 * The public estimate: what the shop would offer for a card, before anyone
 * signs in.
 *
 * Both routes are unauthenticated and rate limited, and neither writes
 * anything or calls an adapter: the search reads the catalogue and the
 * estimate reads cached prices through the shared offer calculator. The
 * customer client is used rather than the counter's so a page open in a
 * staff browser never sends a staff token to a public route.
 */
import { pbCustomer } from "@/lib/pb-customer"
import { isDemo } from "@/lib/api/mode"
import { demoEstimate, demoEstimateSearch } from "@/lib/api/demo/estimate"
import type { EstimateCardHit, EstimateResult } from "@/lib/api/types"

export async function searchEstimateCards(query: string): Promise<EstimateCardHit[]> {
  const raw = query.trim()
  if (raw.length < 2) return []
  if (isDemo()) return demoEstimateSearch(raw)
  const result = await pbCustomer.send<{ cards: EstimateCardHit[] }>(
    `/api/vault/estimate/search?q=${encodeURIComponent(raw)}`,
    { method: "GET" }
  )
  return result.cards ?? []
}

export async function getEstimate(
  cardId: string,
  condition: string,
  finish: string
): Promise<EstimateResult> {
  if (isDemo()) {
    return demoEstimate(cardId, condition as "NM", finish)
  }
  const params = new URLSearchParams({ card: cardId, condition })
  if (finish) params.set("finish", finish)
  return pbCustomer.send<EstimateResult>(
    `/api/vault/estimate?${params.toString()}`,
    { method: "GET" }
  )
}
