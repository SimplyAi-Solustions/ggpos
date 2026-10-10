/**
 * The category tree as the web app reads it (docs/api-contract-inventory.md,
 * section 1.6): the picker's levels and search, the editor's rows and what a
 * drop on one of them means.
 *
 * Everything here works on the flat `CategoryBranch[]` the tree route
 * answers, depth first in tree order, so a branch's children are simply the
 * rows whose `parent` is its id, in the order they come. The derived fields
 * (`lineage`, `depth`, `visible`) are the server's; nothing here works them
 * out again.
 *
 * Pure, so the drop rules are unit tested without a pointer in sight.
 */
import {
  CATEGORY_PATH_SEPARATOR,
  isWithin,
  moveProblem,
  type CategoryBranch,
} from "@gg/shared"

// ---------------------------------------------------------------------------
// Reading the tree
// ---------------------------------------------------------------------------

/** "Pokémon" and "pokemon" are the same word to somebody typing at a till. */
export function foldText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
}

export function branchById(
  branches: readonly CategoryBranch[],
  id: string | null | undefined
): CategoryBranch | undefined {
  if (!id) return undefined
  return branches.find((branch) => branch.id === id)
}

/** A branch's children in order ("" for the top level). */
export function childrenOf(
  branches: readonly CategoryBranch[],
  parent: string,
  options: { visibleOnly?: boolean } = {}
): CategoryBranch[] {
  return branches.filter(
    (branch) => branch.parent === parent && (!options.visibleOnly || branch.visible)
  )
}

/** The ids in a lineage, top first: "|a|b|c|" is a, b, c. */
export function lineageIds(lineage: string): string[] {
  return lineage.split("|").filter(Boolean)
}

/** The branch and everything above it, top first. */
export function trailOf(branches: readonly CategoryBranch[], id: string): CategoryBranch[] {
  const branch = branchById(branches, id)
  if (!branch) return []
  return lineageIds(branch.lineage)
    .map((entry) => branchById(branches, entry))
    .filter((entry): entry is CategoryBranch => Boolean(entry))
}

/** "Pokémon / Singles": the last levels of a path, which is what a column has room for. */
export function lastLevels(path: string, count = 2): string {
  if (!path) return ""
  return path.split(CATEGORY_PATH_SEPARATOR).slice(-count).join(CATEGORY_PATH_SEPARATOR)
}

/** How many levels sit below a branch: 0 for a leaf. */
export function heightOf(branches: readonly CategoryBranch[], id: string): number {
  const branch = branchById(branches, id)
  if (!branch) return 0
  let deepest = branch.depth
  for (const entry of branches) {
    if (entry.id !== branch.id && isWithin(entry.lineage, branch.id)) {
      deepest = Math.max(deepest, entry.depth)
    }
  }
  return deepest - branch.depth
}

/** Whether a branch has visible branches beneath it, for the picker's chevron. */
export function hasVisibleChildren(branches: readonly CategoryBranch[], id: string): boolean {
  return branches.some((branch) => branch.parent === id && branch.visible)
}

// ---------------------------------------------------------------------------
// The picker's search
// ---------------------------------------------------------------------------

export interface BranchMatch {
  branch: CategoryBranch
  /** The path a level at a time, each marked where the words were found. */
  levels: { name: string; match: boolean }[]
}

/**
 * Every branch whose path has all of the words in it, at any level, the
 * branches whose own name matches first and then the rest, each in tree
 * order. "pokemon singles" finds Trading cards / Pokémon / Singles; "sega"
 * finds Sega and everything under it.
 */
export function searchBranches(
  branches: readonly CategoryBranch[],
  query: string,
  options: { limit?: number; offered?: (branch: CategoryBranch) => boolean } = {}
): BranchMatch[] {
  const words = foldText(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const limit = options.limit ?? 40
  const own: BranchMatch[] = []
  const beneath: BranchMatch[] = []
  for (const branch of branches) {
    if (options.offered && !options.offered(branch)) continue
    const names = branch.path.split(CATEGORY_PATH_SEPARATOR)
    const folded = names.map(foldText)
    if (!words.every((word) => folded.some((name) => name.includes(word)))) continue
    const levels = names.map((name, index) => ({
      name,
      match: words.some((word) => (folded[index] ?? "").includes(word)),
    }))
    const last = folded[folded.length - 1] ?? ""
    const entry = { branch, levels }
    if (words.some((word) => last.includes(word))) own.push(entry)
    else beneath.push(entry)
  }
  return [...own, ...beneath].slice(0, limit)
}

// ---------------------------------------------------------------------------
// The editor's rows
// ---------------------------------------------------------------------------

/** The rows the editor draws: a branch shows when every branch above it is open. */
export function shownRows(
  branches: readonly CategoryBranch[],
  open: ReadonlySet<string>
): CategoryBranch[] {
  return branches.filter((branch) =>
    lineageIds(branch.lineage)
      .slice(0, -1)
      .every((id) => open.has(id))
  )
}

/** Top level open, the rest closed: how the editor first draws the tree. */
export function defaultOpen(branches: readonly CategoryBranch[]): Set<string> {
  return new Set(branches.filter((branch) => branch.depth === 0).map((branch) => branch.id))
}

// ---------------------------------------------------------------------------
// What a drop means
// ---------------------------------------------------------------------------

/** Where on a row the pointer is: its top edge, its bottom edge, or the middle. */
export type DropZone = "before" | "after" | "inside"

/** The top and bottom quarters put a branch beside the row, the middle inside it. */
export function zoneFor(offsetY: number, height: number): DropZone {
  if (height <= 0) return "inside"
  const ratio = offsetY / height
  if (ratio < 0.25) return "before"
  if (ratio > 0.75) return "after"
  return "inside"
}

export type DropPlan =
  /** Same parent, new order: `POST /api/vault/categories/reorder`. */
  | { route: "reorder"; parent: string; order: string[]; sentence: string }
  /** A new parent: `POST /api/vault/categories/{id}/move`. */
  | { route: "move"; id: string; parent: string; before?: string; sentence: string }
  /** Not allowed, in the server's own words. */
  | { problem: string }

function nameOf(branches: readonly CategoryBranch[], id: string): string {
  return branchById(branches, id)?.name ?? "the top level"
}

/** Whether `parent` can take `id`, in `moveProblem`'s words, or null. */
function parentProblem(
  branches: readonly CategoryBranch[],
  id: string,
  parent: string
): string | null {
  const into = parent ? branchById(branches, parent) : null
  if (parent && !into) return "That parent branch was not found."
  return moveProblem(
    id,
    into ? { lineage: into.lineage, depth: into.depth } : null,
    heightOf(branches, id)
  )
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

/**
 * The order of `parent`'s children with `id` put at `at` (an index into the
 * siblings without it), or null when that is the order already.
 */
function reorderPlan(
  branches: readonly CategoryBranch[],
  id: string,
  parent: string,
  at: number
): DropPlan | null {
  const siblings = childrenOf(branches, parent).map((branch) => branch.id)
  const without = siblings.filter((entry) => entry !== id)
  const order = [...without.slice(0, at), id, ...without.slice(at)]
  if (sameOrder(order, siblings)) return null
  const next = order[order.indexOf(id) + 1]
  return {
    route: "reorder",
    parent,
    order,
    sentence: next
      ? `Put ${nameOf(branches, id)} before ${nameOf(branches, next)}.`
      : `Put ${nameOf(branches, id)} last in ${nameOf(branches, parent)}.`,
  }
}

/**
 * What dropping `id` on `target` in `zone` does: a reorder among the same
 * siblings, a move under another parent, a refusal (into itself or one of
 * its own branches, or too deep), or null for a drop that changes nothing.
 * Every child of a parent counts, switched off or not, because the reorder
 * route takes them all.
 */
export function planDrop(
  branches: readonly CategoryBranch[],
  id: string,
  target: string,
  zone: DropZone
): DropPlan | null {
  const dragged = branchById(branches, id)
  const onto = branchById(branches, target)
  if (!dragged || !onto || dragged.id === onto.id) return null

  const parent = zone === "inside" ? onto.id : onto.parent
  const problem = parentProblem(branches, dragged.id, parent)
  if (problem) return { problem }

  const siblings = childrenOf(branches, parent)
    .map((branch) => branch.id)
    .filter((entry) => entry !== dragged.id)

  if (parent === dragged.parent) {
    const at =
      zone === "inside"
        ? siblings.length
        : siblings.indexOf(onto.id) + (zone === "after" ? 1 : 0)
    return reorderPlan(branches, dragged.id, parent, at)
  }

  const before =
    zone === "inside"
      ? undefined
      : zone === "before"
        ? onto.id
        : siblings[siblings.indexOf(onto.id) + 1]
  return {
    route: "move",
    id: dragged.id,
    parent,
    ...(before ? { before } : {}),
    sentence: before
      ? `Move ${dragged.name} into ${nameOf(branches, parent)}, before ${nameOf(branches, before)}.`
      : `Move ${dragged.name} into ${nameOf(branches, parent)}, last.`,
  }
}

/**
 * "Move to" through the picker: last under the chosen parent ("" for the
 * top level). Null when it is already there.
 */
export function planMoveTo(
  branches: readonly CategoryBranch[],
  id: string,
  parent: string
): DropPlan | null {
  const dragged = branchById(branches, id)
  if (!dragged || dragged.parent === parent) return null
  const problem = parentProblem(branches, id, parent)
  if (problem) return { problem }
  return {
    route: "move",
    id,
    parent,
    sentence: `Move ${dragged.name} into ${nameOf(branches, parent)}, last.`,
  }
}

/** One place up or down among its siblings, from the keyboard. Null at either end. */
export function planNudge(
  branches: readonly CategoryBranch[],
  id: string,
  step: -1 | 1
): DropPlan | null {
  const branch = branchById(branches, id)
  if (!branch) return null
  const siblings = childrenOf(branches, branch.parent).map((entry) => entry.id)
  const at = siblings.indexOf(id) + step
  if (at < 0 || at >= siblings.length) return null
  return reorderPlan(branches, id, branch.parent, at)
}

/** Whether a picker may offer `candidate` as the new parent of `id`. */
export function canTake(id: string, candidate: CategoryBranch): boolean {
  return candidate.visible && !isWithin(candidate.lineage, id)
}
