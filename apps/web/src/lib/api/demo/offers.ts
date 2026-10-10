/**
 * What a demo loyalty offer can name: the demo till's products and the stock
 * on the demo shelf, each with the branch it is filed in
 * (`demo/branches.ts`), for the Offers editor's pickers.
 */
import {
  demoBranchForItem,
  demoBranchForProduct,
} from "@/lib/api/demo/branches"
import { DEMO_TILL_PRODUCTS } from "@/lib/api/demo/till"
import { itemStore } from "@/lib/api/demo/store"
import type { OfferItem, OfferProduct } from "@/lib/api/offers"
import type { StockItemRecord } from "@/lib/api/types"

export { demoBranches } from "@/lib/api/demo/branches"

export function demoOfferProducts(): OfferProduct[] {
  return DEMO_TILL_PRODUCTS.map((product) => ({
    id: product.id,
    name: product.name,
    price: product.price,
    active: product.active,
    category: demoBranchForProduct(product.id),
  }))
}

function toOfferItem(item: StockItemRecord): OfferItem {
  return {
    id: item.id,
    sku: item.sku,
    title: item.title || item.sku,
    price: item.price ?? 0,
    category: demoBranchForItem(item),
  }
}

/** In-stock demo items by title or code, a page of them. */
export function demoSearchOfferItems(query: string): OfferItem[] {
  const needle = query.trim().toLowerCase()
  return itemStore()
    .filter((item) => item.status === "in_stock")
    .filter(
      (item) =>
        !needle ||
        (item.title ?? "").toLowerCase().includes(needle) ||
        item.sku.toLowerCase().includes(needle)
    )
    .slice(0, 12)
    .map(toOfferItem)
}

export function demoOfferItems(ids: string[]): OfferItem[] {
  const wanted = new Set(ids)
  return itemStore()
    .filter((item) => wanted.has(item.id))
    .map(toOfferItem)
}
