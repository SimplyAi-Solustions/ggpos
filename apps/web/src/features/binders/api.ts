/**
 * Binders: collections a customer is building, ported from GG HQ.
 *
 * Reading binders and pockets goes through the `binders` and `binder_cards`
 * collection rules (own rows only). Creating a binder, the catalogue lists,
 * adding cards, moving and ticking pockets, share links and wanted requests
 * go through `/api/vault/binders/*` and `/api/vault/binder-*` so card data
 * always comes from the catalogue. Nothing here carries a price, and every
 * response passes through stripPrices before a screen sees it.
 */
import { pbCustomer } from "@/lib/pb-customer"
import { stripPrices, type Grid, type LayoutDiff } from "@/features/binders/layout"

export type BinderKind = "pokemon" | "set" | "illustrator" | "custom" | "pokedex"

export interface Binder {
  id: string
  name: string
  owner: string
  kind: BinderKind
  query: string
  query_label: string
  color: string
  cover: string
  logo: string
  sort: number
  grid: string
  min_slots: number
  share_token: string
  dex_scope: string
}

export interface BinderCard {
  id: string
  binder: string
  card_id: string
  variant: string
  name: string
  number: string
  set_id: string
  set_name: string
  set_total: string
  rarity: string
  image: string
  sort: number
  slot: number
  owned: boolean
  dex: number
  sprite: string
  group_name: string
  group_shape: string
  manual: boolean
}

export interface WantedRequest {
  id: string
  card_id: string
  card_name: string
  binder: string
  status: "open" | "cancelled" | "fulfilled"
  created: string
}

export interface SetEntry {
  id: string
  name: string
  serie: string
  serie_name: string
  logo: string
  official: number
  total: number
}
export interface Species {
  id: number
  slug: string
  label: string
}
export interface SearchHit {
  card_id: string
  name: string
  number: string
  set_name: string
  image: string
}
export interface Preview {
  count: number
  sets: number
  sample: { name: string; image: string; set_name: string }[]
}

/** National Pokedex and the nine generations. Mirrors pb/pb_hooks/lib/binders_v2.js. */
export const DEX_SCOPES = [
  { id: "national", label: "National Pokédex", from: 1, to: 1025 },
  { id: "gen1", label: "Generation 1, Kanto", from: 1, to: 151 },
  { id: "gen2", label: "Generation 2, Johto", from: 152, to: 251 },
  { id: "gen3", label: "Generation 3, Hoenn", from: 252, to: 386 },
  { id: "gen4", label: "Generation 4, Sinnoh", from: 387, to: 493 },
  { id: "gen5", label: "Generation 5, Unova", from: 494, to: 649 },
  { id: "gen6", label: "Generation 6, Kalos", from: 650, to: 721 },
  { id: "gen7", label: "Generation 7, Alola", from: 722, to: 809 },
  { id: "gen8", label: "Generation 8, Galar", from: 810, to: 905 },
  { id: "gen9", label: "Generation 9, Paldea", from: 906, to: 1025 },
] as const

export const COLORS = [
  { id: "volt", c: "#fedf01", l: "Volt" },
  { id: "pop", c: "#ff2e6b", l: "Pop" },
  { id: "cyan", c: "#3ee6ff", l: "Cyan" },
  { id: "violet", c: "#a78bfa", l: "Violet" },
  { id: "lime", c: "#9cff6e", l: "Lime" },
  { id: "orange", c: "#ff9a3c", l: "Orange" },
  { id: "onyx", c: "#8a8a99", l: "Onyx" },
] as const

export const colorOf = (id: string) => (COLORS.find((x) => x.id === id) ?? COLORS[0]).c

export const KINDS: Record<BinderKind, string> = {
  pokemon: "Pokémon",
  set: "Set",
  illustrator: "Artist",
  custom: "Your picks",
  pokedex: "Pokédex",
}

/** TCGdex hands out image bases; the file is `<base>/<quality>.webp`. */
export const img = (base: string, q: "low" | "high" = "low") =>
  !base ? "" : /\.(jpe?g|png|webp)(\?|$)/i.test(base) ? base : `${base}/${q}.webp`

export const artwork = (dex: number) =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${dex}.png`

export interface BinderStats {
  total: number
  got: number
  cover: string
}

/** Shelf progress. Cards taken out of the binder (slot -1) do not count. */
export function statsFor(cards: (Pick<BinderCard, "owned" | "image"> & Partial<Pick<BinderCard, "slot">>)[]): BinderStats {
  const s = { total: 0, got: 0, cover: "" }
  for (const c of cards) {
    if (typeof c.slot === "number" && c.slot < 0) continue
    s.total++
    if (c.owned) {
      s.got++
      if (!s.cover && c.image) s.cover = c.image
    }
  }
  return s
}

export async function listBinders(): Promise<Binder[]> {
  return stripPrices(await pbCustomer.collection("binders").getFullList<Binder>({ sort: "-sort" }))
}

export async function getBinder(id: string): Promise<Binder> {
  return stripPrices(await pbCustomer.collection("binders").getOne<Binder>(id))
}

/** A light list of every pocket, for the shelf's progress bars. */
export async function listAllPockets(): Promise<Pick<BinderCard, "id" | "binder" | "owned" | "image" | "slot">[]> {
  return stripPrices(
    await pbCustomer
      .collection("binder_cards")
      .getFullList<Pick<BinderCard, "id" | "binder" | "owned" | "image" | "slot">>({
        fields: "id,binder,owned,image,slot",
        sort: "sort",
        batch: 1000,
      })
  )
}

export async function listPockets(binderId: string): Promise<BinderCard[]> {
  return stripPrices(
    await pbCustomer.collection("binder_cards").getFullList<BinderCard>({
      filter: pbCustomer.filter("binder = {:b}", { b: binderId }),
      sort: "slot,sort",
      batch: 1000,
    })
  )
}

export function updateBinder(id: string, patch: { name?: string; owner?: string; color?: string; grid?: Grid }) {
  return pbCustomer.collection("binders").update<Binder>(id, patch)
}

export function deleteBinder(id: string) {
  return pbCustomer.collection("binders").delete(id)
}

/** Moves, ticks and page changes in one batch (multi-select, pages, undo, redo). */
export function saveLayout(binderId: string, diff: LayoutDiff): Promise<{ changed: number }> {
  return pbCustomer.send(`/api/vault/binders/${encodeURIComponent(binderId)}/layout`, {
    method: "POST",
    body: diff,
  })
}

export function shareBinder(binderId: string): Promise<{ token: string }> {
  return pbCustomer.send(`/api/vault/binders/${encodeURIComponent(binderId)}/share`, { method: "POST" })
}

export function unshareBinder(binderId: string): Promise<{ token: string }> {
  return pbCustomer.send(`/api/vault/binders/${encodeURIComponent(binderId)}/share`, { method: "DELETE" })
}

export const shareUrl = (token: string) =>
  `${typeof window === "undefined" ? "" : window.location.origin}/binder/${encodeURIComponent(token)}`

export async function listWanted(): Promise<WantedRequest[]> {
  return stripPrices(
    await pbCustomer.collection("binder_wanted").getFullList<WantedRequest>({
      filter: "status = 'open'",
      fields: "id,card_id,card_name,binder,status,created",
      batch: 500,
    })
  )
}

export function wantCard(pocketId: string): Promise<{ id: string; card_id: string; existed?: boolean }> {
  return pbCustomer.send("/api/vault/binder-wanted", { method: "POST", body: { pocket: pocketId } })
}

export function cancelWanted(id: string): Promise<{ id: string; status: string }> {
  return pbCustomer.send(`/api/vault/binder-wanted/${encodeURIComponent(id)}`, { method: "DELETE" })
}

export interface SharedBinder {
  binder: Pick<Binder, "name" | "kind" | "query_label" | "color" | "cover" | "logo" | "grid" | "min_slots">
  pockets: Omit<BinderCard, "binder" | "manual">[]
}

/** The public share view. No session needed; the token is the key. */
export async function getShared(token: string): Promise<SharedBinder> {
  const res = await fetch(pbCustomer.buildURL(`/api/vault/binder-share/${encodeURIComponent(token)}`), {
    headers: { accept: "application/json" },
  })
  const body = (await res.json().catch(() => ({}))) as { message?: string }
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? "This share link has been switched off or never existed. Ask for a new link."
        : "The binder did not load. Check your connection and try again."
    )
  }
  return stripPrices(body as SharedBinder)
}

const catalogueCache: Record<string, Promise<unknown> | undefined> = {}
function catalogue<T>(what: string): Promise<T> {
  let hit = catalogueCache[what] as Promise<T> | undefined
  if (!hit) {
    hit = pbCustomer.send<T>(`/api/vault/binders/catalog/${what}`, {}).then((r) => stripPrices(r))
    hit.catch(() => {
      delete catalogueCache[what]
    })
    catalogueCache[what] = hit
  }
  return hit
}

export const listSets = () => catalogue<{ sets: SetEntry[] }>("sets").then((r) => r.sets)
export const listSpecies = () => catalogue<{ species: Species[] }>("pokemon").then((r) => r.species)
export const listIllustrators = () =>
  catalogue<{ illustrators: string[] }>("illustrators").then((r) => r.illustrators)

export async function previewBinder(kind: BinderKind, query: string): Promise<Preview> {
  return stripPrices(
    await pbCustomer.send<Preview>("/api/vault/binders/preview", {
      method: "POST",
      body: { kind, query },
    })
  )
}

export function createBinder(input: {
  kind: BinderKind
  query: string
  query_label: string
  name: string
  owner: string
  color: string
  grid: Grid
}): Promise<{ id: string; cards: number }> {
  return pbCustomer.send("/api/vault/binders", { method: "POST", body: input })
}

export async function searchCards(q: string): Promise<SearchHit[]> {
  const r = await pbCustomer.send<{ cards: SearchHit[] }>(`/api/vault/binders/search`, { query: { q } })
  return stripPrices(r.cards)
}

export function addCard(
  binderId: string,
  cardId: string,
  slot?: number
): Promise<{ id: string; slot: number; existed?: boolean; restored?: boolean }> {
  return pbCustomer.send(`/api/vault/binders/${encodeURIComponent(binderId)}/add`, {
    method: "POST",
    body: slot === undefined ? { card_id: cardId } : { card_id: cardId, slot },
  })
}
