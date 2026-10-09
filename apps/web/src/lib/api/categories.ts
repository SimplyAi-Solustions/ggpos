/**
 * The category tree's reads and writes (docs/api-contract-inventory.md,
 * section 1.3): the tree, moving and reordering branches, filing stock and
 * till products into a branch, the till's branch view, and the plain
 * collection writes the Settings editor makes (add, rename, switch off and
 * on, defaults and picture, delete).
 *
 * Every write goes through `withOverride`, because the routes need
 * `stock_manage` and answer a role without it with the usual 403 and its
 * `capability`; the approval dialog asks a manager and the same call goes
 * again. The routes that change the tree's shape answer with the whole tree,
 * and the editor redraws from that rather than from what it asked for.
 *
 * Demo mode answers every route from `demo/categories.ts` and the till's
 * demo, with the server's shapes and sentences.
 */
import { useQuery } from "@tanstack/react-query"
import type {
  CategoryKind,
  CategoryTaxScheme,
  CategoryTree,
  TillBranchView,
} from "@gg/shared"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { noteNetworkSuccess } from "@/lib/offline/net"
import { withOverride } from "@/features/lock/override"
import { PLATFORMS, PLATFORM_KEYS } from "@/design/platforms"
import * as demo from "@/lib/api/demo/categories"
import { demoProductsIn, demoTillBranch } from "@/lib/api/demo/till"

export const CATEGORY_TREE_KEY = ["category-tree"] as const

function quote(value: string): string {
  return value.replace(/["\\]/g, "\\$&")
}

const TREE_CHANGE = () => "Change the category tree"

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** `GET /api/vault/categories/tree`: every branch, depth first, switched off or not. */
export async function getCategoryTree(): Promise<CategoryTree> {
  if (isDemo()) return demo.demoCategoryTree()
  const tree = await pb.send<CategoryTree>("/api/vault/categories/tree", { method: "GET" })
  noteNetworkSuccess()
  return { branches: tree.branches ?? [] }
}

/** The tree, shared by every screen that shows or picks a branch. */
export function useCategoryTree(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: CATEGORY_TREE_KEY,
    queryFn: getCategoryTree,
    staleTime: 30_000,
    enabled: options.enabled ?? true,
  })
}

/**
 * `GET /api/vault/till/branch/{id}`: the till's view of one branch, a page
 * of its stock at a time; with words, what matches anywhere beneath it.
 */
export async function getTillBranch(
  id: string,
  query: { q?: string; page?: number } = {}
): Promise<TillBranchView> {
  const q = query.q?.trim() ?? ""
  if (isDemo()) return demoTillBranch(id, { q, page: query.page })
  const view = await pb.send<TillBranchView>(`/api/vault/till/branch/${encodeURIComponent(id)}`, {
    method: "GET",
    query: { ...(q ? { q } : {}), page: query.page ?? 1 },
  })
  noteNetworkSuccess()
  return view
}

export interface PlatformOption {
  id: string
  key: string
  name: string
}

/** The `platforms` rows a branch's default platform is chosen from. */
export async function listPlatforms(): Promise<PlatformOption[]> {
  if (isDemo()) {
    return PLATFORM_KEYS.map((key) => ({
      id: demo.demoPlatformId(key),
      key,
      name: PLATFORMS[key].label,
    }))
  }
  return pb
    .collection("platforms")
    .getFullList<PlatformOption>({ fields: "id,key,name", sort: "sort,name" })
}

/** The active till products whose home is this branch, for "File these". */
export async function listProductsInCategory(id: string): Promise<{ id: string; name: string }[]> {
  if (isDemo()) return demoProductsIn(id)
  return pb.collection("till_products").getFullList<{ id: string; name: string }>({
    filter: `category = "${quote(id)}" && active = true`,
    fields: "id,name",
    sort: "name",
  })
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

/** `POST /api/vault/categories/{id}/move`: under `parent` ("" for the top), before `before` or last. */
export async function moveCategory(
  id: string,
  input: { parent: string; before?: string }
): Promise<CategoryTree> {
  const body = { parent: input.parent, ...(input.before ? { before: input.before } : {}) }
  return withOverride(
    async (headers) => {
      if (isDemo()) return demo.demoMoveCategory(id, body, headers)
      const tree = await pb.send<CategoryTree>(
        `/api/vault/categories/${encodeURIComponent(id)}/move`,
        { method: "POST", body, headers }
      )
      return { branches: tree.branches ?? [] }
    },
    { describe: TREE_CHANGE }
  )
}

/** `POST /api/vault/categories/reorder`: every child of `parent`, once, in the new order. */
export async function reorderCategories(parent: string, order: string[]): Promise<CategoryTree> {
  const body = { parent, order }
  return withOverride(
    async (headers) => {
      if (isDemo()) return demo.demoReorderCategories(body, headers)
      const tree = await pb.send<CategoryTree>("/api/vault/categories/reorder", {
        method: "POST",
        body,
        headers,
      })
      return { branches: tree.branches ?? [] }
    },
    { describe: TREE_CHANGE }
  )
}

/** `POST /api/vault/categories/assign`: up to 500 stock rows and till products into one branch. */
export async function assignCategory(input: {
  category: string
  items?: string[]
  products?: string[]
}): Promise<{ items: number; products: number }> {
  const body = {
    category: input.category,
    ...(input.items?.length ? { items: input.items } : {}),
    ...(input.products?.length ? { products: input.products } : {}),
  }
  return withOverride(
    async (headers) => {
      if (isDemo()) return demo.demoAssignCategory(body, headers)
      return pb.send<{ items: number; products: number }>("/api/vault/categories/assign", {
        method: "POST",
        body,
        headers,
      })
    },
    { describe: () => "File stock in a branch" }
  )
}

// ---------------------------------------------------------------------------
// The collection writes (section 1.2's rules apply to them as to the routes)
// ---------------------------------------------------------------------------

/** A new branch, last among its siblings. The server works out its path. */
export async function createCategory(input: {
  name: string
  parent: string
  sort: number
}): Promise<void> {
  await withOverride(
    async (headers) => {
      if (isDemo()) {
        demo.demoCreateCategory({ name: input.name, parent: input.parent }, headers)
        return
      }
      await pb.collection("categories").create(
        { name: input.name.trim(), parent: input.parent, sort: input.sort, active: true },
        { headers }
      )
    },
    { describe: TREE_CHANGE }
  )
}

export interface CategoryPatch {
  name?: string
  active?: boolean
  default_kind?: CategoryKind | ""
  /** A `games` id, or "" for none. */
  default_game?: string
  /** A `platforms` id, or "" for none. */
  default_platform?: string
  default_tax_scheme?: CategoryTaxScheme | ""
  /** A new picture, or null to take it off. */
  image?: File | null
}

/** Rename, switch off or on, defaults and picture. */
export async function updateCategory(id: string, patch: CategoryPatch): Promise<void> {
  await withOverride(
    async (headers) => {
      if (isDemo()) {
        const { image, ...rest } = patch
        demo.demoUpdateCategory(
          id,
          {
            ...rest,
            ...(image === undefined
              ? {}
              : { image_url: image ? URL.createObjectURL(image) : "" }),
          },
          headers
        )
        return
      }
      const { image, ...fields } = patch
      if (image) {
        const form = new FormData()
        for (const [name, value] of Object.entries(fields)) {
          if (value !== undefined) form.append(name, String(value))
        }
        form.append("image", image)
        await pb.collection("categories").update(id, form, { headers })
        return
      }
      await pb
        .collection("categories")
        .update(id, image === null ? { ...fields, image: null } : fields, { headers })
    },
    { describe: TREE_CHANGE }
  )
}

/** Only an empty branch goes; the server says what is still in one that is not. */
export async function deleteCategory(id: string): Promise<void> {
  await withOverride(
    async (headers) => {
      if (isDemo()) {
        demo.demoDeleteCategory(id, headers)
        return
      }
      await pb.collection("categories").delete(id, { headers })
    },
    { describe: TREE_CHANGE }
  )
}
