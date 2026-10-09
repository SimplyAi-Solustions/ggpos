/**
 * What a loyalty offer can name (docs/api-contract-launch.md, section 2):
 * branches of the category tree, stock items and till products, read for
 * the Offers editor's pickers and for the till's points preview.
 *
 * The branches come from `GET /api/vault/categories/tree`, which every staff
 * member may read, with each branch's `lineage` ("|rootId|...|ownId|"): the
 * shared evaluator matches an offer on a branch against a line's lineage, so
 * the till needs it for every line it prices. Items and till products are
 * read through the collection API, which staff may list.
 *
 * Demo mode answers from the demo shop's starter tree and shelf.
 */
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import type { CategoryTree } from "@gg/shared"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { escapeFilter } from "@/lib/api/filter"
import {
  demoBranches,
  demoOfferItems,
  demoOfferProducts,
  demoSearchOfferItems,
} from "@/lib/api/demo/offers"

/** A branch an offer can name. */
export interface OfferBranch {
  id: string
  name: string
  /** "Trading cards / Pokémon / Singles". */
  path: string
  lineage: string
  depth: number
  active: boolean
}

/** A till product an offer can name. */
export interface OfferProduct {
  id: string
  name: string
  /** Pence; 0 for an open-price key. */
  price: number
  active: boolean
  /** Its home branch, or "". */
  category: string
}

/** A stock item an offer can name. */
export interface OfferItem {
  id: string
  sku: string
  title: string
  /** Pence. */
  price: number
  category: string
}

export async function listOfferBranches(): Promise<OfferBranch[]> {
  if (isDemo()) return demoBranches()
  const tree = await pb.send<CategoryTree>("/api/vault/categories/tree", { method: "GET" })
  return (tree.branches ?? []).map((branch) => ({
    id: branch.id,
    name: branch.name,
    path: branch.path,
    lineage: branch.lineage,
    depth: branch.depth,
    active: branch.visible,
  }))
}

interface ProductRow {
  id: string
  name?: string
  price?: number
  active?: boolean
  category?: string
}

export async function listOfferProducts(): Promise<OfferProduct[]> {
  if (isDemo()) return demoOfferProducts()
  const rows = await pb.collection("till_products").getFullList<ProductRow>({ sort: "sort,name" })
  return rows.map((row) => ({
    id: row.id,
    name: row.name ?? "",
    price: row.price ?? 0,
    active: row.active !== false,
    category: row.category ?? "",
  }))
}

interface ItemRow {
  id: string
  sku?: string
  title?: string
  price?: number
  category?: string
}

function toOfferItem(row: ItemRow): OfferItem {
  return {
    id: row.id,
    sku: row.sku ?? "",
    title: row.title || row.sku || "",
    price: row.price ?? 0,
    category: row.category ?? "",
  }
}

/** Stock on the shelf by title or code, for the Offers editor's item search. */
export async function searchOfferItems(query: string): Promise<OfferItem[]> {
  if (isDemo()) return demoSearchOfferItems(query)
  const needle = escapeFilter(query.trim())
  const page = await pb.collection("items").getList<ItemRow>(1, 12, {
    filter: needle
      ? `status = "in_stock" && (title ~ "${needle}" || sku ~ "${needle}")`
      : `status = "in_stock"`,
    sort: "title",
    fields: "id,sku,title,price,category",
  })
  return page.items.map(toOfferItem)
}

/** The items an offer already names, for its sentence. */
export async function getOfferItems(ids: string[]): Promise<OfferItem[]> {
  if (ids.length === 0) return []
  if (isDemo()) return demoOfferItems(ids)
  const filter = ids.map((id) => `id = "${escapeFilter(id)}"`).join(" || ")
  const rows = await pb.collection("items").getFullList<ItemRow>({
    filter,
    fields: "id,sku,title,price,category",
  })
  return rows.map(toOfferItem)
}

export const offerBranchesQuery = {
  queryKey: ["offer-branches"] as const,
  queryFn: listOfferBranches,
  staleTime: 5 * 60_000,
}

/**
 * Every branch's lineage by its id, for the till: a line knows its home
 * branch, and an offer on a branch matches by lineage. Empty until the tree
 * has been read, which prices a line as if it named no branch.
 */
export function useBranchLineages(): Record<string, string> {
  const { data } = useQuery(offerBranchesQuery)
  return React.useMemo(
    () => Object.fromEntries((data ?? []).map((branch) => [branch.id, branch.lineage])),
    [data]
  )
}
