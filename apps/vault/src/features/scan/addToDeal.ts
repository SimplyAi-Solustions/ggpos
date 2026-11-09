/**
 * The one hand-off from Scan and Cards to Deals. For now it is a URL the
 * deals screens read: `/deals/<id>?add=<cardId>&condition=NM` adds the card
 * to that deal, and `/deals?add=<cardId>&condition=NM` asks which deal (or a
 * new one) when Scan was not opened from a deal.
 *
 * A batch from the scan tray uses the same two keys as comma lists, one
 * entry per card in the same order: `?add=a,b,b&condition=NM,LP,LP`.
 */
import type { CardCondition } from "@/features/cards/condition-prices"

export function addToDealHref(dealId: string | null | undefined, cardId: string, condition: CardCondition = "NM"): string {
  return addManyToDealHref(dealId, [{ cardId, condition }])
}

export function addManyToDealHref(dealId: string | null | undefined, units: readonly { cardId: string; condition: CardCondition }[]): string {
  const query = new URLSearchParams({
    add: units.map((u) => u.cardId).join(","),
    condition: units.map((u) => u.condition).join(","),
  }).toString()
  return dealId ? `/deals/${encodeURIComponent(dealId)}?${query}` : `/deals?${query}`
}

/** Navigates with the router's `navigate({ href })`, so history and transitions stay normal. */
export function addToDeal(
  navigate: (options: { href: string }) => unknown,
  dealId: string | null | undefined,
  cardId: string,
  condition: CardCondition = "NM"
): void {
  void navigate({ href: addToDealHref(dealId, cardId, condition) })
}
