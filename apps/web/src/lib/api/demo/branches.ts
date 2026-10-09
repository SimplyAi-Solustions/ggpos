/**
 * The demo shop's category tree, and where its stock and till products are
 * filed in it, for loyalty offers on a branch (docs/api-contract-launch.md,
 * section 2).
 *
 * The tree is the starter tree every new shop is seeded with
 * (`starterBranches` in packages/shared), under ids made from the seeded
 * keys, so a branch picked in the Offers editor and the branch a demo item
 * is filed in are the same id. Items are filed by the shared `fileItem`
 * rule, the one the server's migration and items hook use, so nothing here
 * keeps a second list of where things live.
 *
 * Kept apart from `demo/offers.ts` so the demo till can file its tiles
 * without importing the shelf back.
 */
import {
  fileItem,
  lineageOf,
  pathOf,
  starterBranches,
  UNSORTED_KEY,
} from "@gg/shared"

import type { OfferBranch } from "@/lib/api/offers"
import type { StockItemRecord } from "@/lib/api/types"

function branchId(key: string): string {
  return `branch_${key.replace(/[^a-z0-9]+/gi, "_")}`
}

let built: OfferBranch[] | null = null

/** Every branch of the demo tree, depth first. */
export function demoBranches(): OfferBranch[] {
  if (built) return built
  const byKey = new Map<string, OfferBranch>()
  const out: OfferBranch[] = []
  for (const { branch, parent } of starterBranches()) {
    const above = parent ? byKey.get(parent) : undefined
    const id = branchId(branch.key)
    const row: OfferBranch = {
      id,
      name: branch.name,
      path: pathOf(above?.path ?? "", branch.name),
      lineage: lineageOf(above?.lineage ?? "", id),
      depth: above ? above.depth + 1 : 0,
      active: true,
    }
    byKey.set(branch.key, row)
    out.push(row)
  }
  built = out
  return out
}

/** The branch a demo item is filed in, by the shared filing rule. */
export function demoBranchForItem(item: Pick<StockItemRecord, "kind" | "game">): string {
  const game = (item.game ?? "").replace(/^game_/, "")
  const key = fileItem({ kind: item.kind, game })
  const id = branchId(key)
  return demoBranches().some((branch) => branch.id === id) ? id : branchId(UNSORTED_KEY)
}

/** Where the seed files each till product (pb_migrations/1789821000_category_tree.js). */
const PRODUCT_BRANCH: Record<string, string> = {
  product_single_card: "tcg",
  product_table_time: "services.tabletime",
  product_event_entry: "services.events",
  product_deposit: "services",
  product_guild_membership: "services.memberships",
}

export function demoBranchForProduct(productId: string): string {
  const key = PRODUCT_BRANCH[productId]
  return key ? branchId(key) : branchId(UNSORTED_KEY)
}

/** A demo branch's lineage, or "" for one the tree does not have. */
export function demoLineageOf(branch: string): string {
  return demoBranches().find((row) => row.id === branch)?.lineage ?? ""
}
