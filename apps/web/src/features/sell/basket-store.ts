/**
 * The open basket, held outside React so the Item page's "Sell" can drop
 * something in and navigate, and so walking to Cash and back does not lose
 * the sale in progress.
 *
 * In memory only: a basket is not a record. Nothing is written until "Mark
 * sold" calls the sale route, which is the only thing that makes it real.
 */
import * as React from "react"

import {
  basketReducer,
  emptyBasket,
  type BasketAction,
  type BasketLine,
  type BasketState,
} from "@/features/sell/basket"
import { itemDetailLine, platformForItem } from "@/lib/api/item-shape"
import { newClientId } from "@/lib/offline/queue"
import type { ItemDetail, ItemSummary } from "@/lib/api/types"

let state: BasketState = emptyBasket()
const listeners = new Set<() => void>()

/**
 * The counter's own id for the sale being built.
 *
 * One id per basket, minted the first time anything needs it and thrown
 * away when the basket is cleared. It is the sale's idempotency key on
 * `sales.complete`, the offline queue's key for the same sale, and the key
 * a card checkout is opened against, so the three can never disagree about
 * which sale they are talking about.
 */
let clientId: string | null = null

export function saleClientId(): string {
  if (!clientId) clientId = newClientId()
  return clientId
}

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getBasket(): BasketState {
  return state
}

export function dispatchBasket(action: BasketAction) {
  const next = basketReducer(state, action)
  // Clearing ends the sale, so the next basket is a new sale with an id of
  // its own: keeping the old one would make the server treat it as a replay
  // of the sale just rung up.
  if (action.type === "clear") clientId = null
  if (next === state) return
  state = next
  emit()
}

/** Re-renders whenever the basket changes. */
export function useBasket(): BasketState {
  return React.useSyncExternalStore(subscribe, getBasket, getBasket)
}

/** Singles, graded cards and retro are one row per unit, so they cap at one. */
function maxQtyFor(kind: ItemDetail["kind"], qty: number): number {
  if (kind === "sealed" || kind === "accessory") return Math.max(1, qty)
  return 1
}

export function lineFromItem(item: ItemDetail): BasketLine {
  return {
    itemId: item.id,
    sku: item.sku,
    title: item.title || "Untitled item",
    detail: itemDetailLine(item),
    kind: item.kind,
    condition: item.condition || "",
    image: item.image,
    platform: platformForItem(item),
    unitPrice: item.price ?? 0,
    listPrice: item.price ?? 0,
    qty: 1,
    maxQty: maxQtyFor(item.kind, item.qty ?? 1),
    game: item.game ?? null,
  }
}

export function lineFromSummary(item: ItemSummary): BasketLine {
  return {
    itemId: item.id,
    sku: item.sku,
    title: item.title,
    detail: item.detail,
    kind: item.kind,
    condition: item.condition,
    image: item.image,
    platform: item.platform,
    unitPrice: item.price,
    listPrice: item.price,
    qty: 1,
    maxQty: maxQtyFor(item.kind, item.qty),
    game: null,
  }
}

/** Used by the Item page's "Sell", which then navigates to the Sell screen. */
export function addItemToBasket(item: ItemDetail) {
  dispatchBasket({ type: "add", line: lineFromItem(item) })
}
