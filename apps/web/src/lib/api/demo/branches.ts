/**
 * The demo shop's category tree as the loyalty offers read it, and where
 * its stock and till products are filed (docs/api-contract-launch.md,
 * section 2).
 *
 * One tree for all of demo mode: this reads the category tree's own demo
 * store (`demo/categories.ts`), so a branch added, renamed or moved in
 * Settings, Categories is the branch an offer names and the branch a demo
 * item is filed in. An item with no branch is filed by the shared
 * `fileItem` rule, the one the server's migration and items hook use.
 *
 * Kept apart from `demo/offers.ts` so the demo till can file its tiles
 * without importing the shelf back.
 */
import { fileItem, UNSORTED_KEY } from "@gg/shared"

import { demoCategoryId, demoCategoryTree, demoProductHome } from "@/lib/api/demo/categories"
import type { OfferBranch } from "@/lib/api/offers"
import type { StockItemRecord } from "@/lib/api/types"

/** Every branch of the demo tree, depth first, switched-off ones marked inactive. */
export function demoBranches(): OfferBranch[] {
  return demoCategoryTree().branches.map((branch) => ({
    id: branch.id,
    name: branch.name,
    path: branch.path,
    lineage: branch.lineage,
    depth: branch.depth,
    active: branch.visible,
  }))
}

/** The branch a demo item is filed in: its own, else by the shared filing rule. */
export function demoBranchForItem(item: Pick<StockItemRecord, "kind" | "game" | "category">): string {
  if (item.category) return item.category
  const game = (item.game ?? "").replace(/^game_/, "")
  const id = demoCategoryId(fileItem({ kind: item.kind, game }))
  return demoBranches().some((branch) => branch.id === id) ? id : demoCategoryId(UNSORTED_KEY)
}

/** Where a demo till product is filed. */
export function demoBranchForProduct(productId: string): string {
  return demoProductHome(productId)
}

/** A demo branch's lineage, or "" for one the tree does not have. */
export function demoLineageOf(branch: string): string {
  return demoBranches().find((row) => row.id === branch)?.lineage ?? ""
}
