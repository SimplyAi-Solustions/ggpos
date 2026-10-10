/**
 * The item page's "Sell": puts the item on the till's ticket. The page then
 * navigates to `/counter/sell`, which redirects to the till, so the item is
 * waiting on the ticket when the till opens.
 *
 * The Sell screen this used to feed is gone (the till replaced it); the
 * ticket itself lives in `features/till/till-store.ts`.
 */
import { dispatchTill } from "@/features/till/till-store"
import { lineFromItem } from "@/features/till/ticket"
import type { ItemDetail } from "@/lib/api/types"

export function addItemToBasket(item: ItemDetail): void {
  dispatchTill({ type: "add", line: lineFromItem(item) })
}
