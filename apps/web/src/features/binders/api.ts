/**
 * Binders: collections a customer is building, ported from GG HQ.
 *
 * Reading and ticking pockets go through the `binders` and `binder_cards`
 * collection rules (own rows only). Creating a binder, the catalogue lists
 * and adding cards go through `/api/vault/binders/*` so card data always
 * comes from the catalogue. Nothing here carries a price.
 */
import { pbCustomer } from "@/lib/pb-customer"

export type BinderKind = "pokemon" | "set" | "illustrator" | "custom"

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
}

export interface BinderCard {
  id: string
  binder: string
  card_id: string
  variant: string
  name: string
  number: string
  set_name: string
  set_total: string
  rarity: string
  image: string
  sort: number
  owned: boolean
  group_name: string
  group_shape: string
  manual: boolean
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

export function statsFor(cards: Pick<BinderCard, "owned" | "image">[]): BinderStats {
  const s = { total: cards.length, got: 0, cover: "" }
  for (const c of cards) {
    if (c.owned) {
      s.got++
      if (!s.cover && c.image) s.cover = c.image
    }
  }
  return s
}

export function listBinders(): Promise<Binder[]> {
  return pbCustomer.collection("binders").getFullList<Binder>({ sort: "-sort" })
}

export function getBinder(id: string): Promise<Binder> {
  return pbCustomer.collection("binders").getOne<Binder>(id)
}

/** A light list of every pocket, for the shelf's progress bars. */
export function listAllPockets(): Promise<Pick<BinderCard, "id" | "binder" | "owned" | "image">[]> {
  return pbCustomer
    .collection("binder_cards")
    .getFullList({ fields: "id,binder,owned,image", sort: "sort", batch: 1000 })
}

export function listPockets(binderId: string): Promise<BinderCard[]> {
  return pbCustomer.collection("binder_cards").getFullList<BinderCard>({
    filter: pbCustomer.filter("binder = {:b}", { b: binderId }),
    sort: "sort",
    batch: 1000,
  })
}

export function setOwned(cardId: string, owned: boolean) {
  return pbCustomer.collection("binder_cards").update<BinderCard>(cardId, {
    owned,
    owned_at: owned ? new Date().toISOString() : null,
  })
}

export function updateBinder(id: string, patch: { name?: string; owner?: string; color?: string }) {
  return pbCustomer.collection("binders").update<Binder>(id, patch)
}

export function deleteBinder(id: string) {
  return pbCustomer.collection("binders").delete(id)
}

export function removePocket(id: string) {
  return pbCustomer.collection("binder_cards").delete(id)
}

const catalogueCache: Record<string, Promise<unknown> | undefined> = {}
function catalogue<T>(what: string): Promise<T> {
  let hit = catalogueCache[what] as Promise<T> | undefined
  if (!hit) {
    hit = pbCustomer.send<T>(`/api/vault/binders/catalog/${what}`, {})
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

export function previewBinder(kind: BinderKind, query: string): Promise<Preview> {
  return pbCustomer.send<Preview>("/api/vault/binders/preview", {
    method: "POST",
    body: { kind, query },
  })
}

export function createBinder(input: {
  kind: BinderKind
  query: string
  query_label: string
  name: string
  owner: string
  color: string
}): Promise<{ id: string; cards: number }> {
  return pbCustomer.send("/api/vault/binders", { method: "POST", body: input })
}

export function searchCards(q: string): Promise<SearchHit[]> {
  return pbCustomer
    .send<{ cards: SearchHit[] }>(`/api/vault/binders/search`, { query: { q } })
    .then((r) => r.cards)
}

export function addCard(binderId: string, cardId: string): Promise<{ id: string; existed?: boolean }> {
  return pbCustomer.send(`/api/vault/binders/${encodeURIComponent(binderId)}/add`, {
    method: "POST",
    body: { card_id: cardId },
  })
}

/** Lays pockets onto 3x3 pages. Grouped scenes never split across a page. */
export function packPages<T extends Pick<BinderCard, "group_name" | "group_shape">>(
  cards: T[]
): (T | null)[][] {
  const blocks: { col: boolean; cards: T[]; w: number; h: number }[] = []
  let i = 0
  while (i < cards.length) {
    const key = cards[i].group_name || ""
    const run: T[] = []
    while (i < cards.length && (cards[i].group_name || "") === key && (key || run.length < 9)) {
      run.push(cards[i])
      i++
      if (run.length === 9) break
    }
    const col = cards[i - 1]?.group_shape === "col" && run.length <= 3 && !!key
    blocks.push({
      col,
      cards: run,
      w: col ? 1 : Math.min(3, run.length),
      h: col ? run.length : Math.ceil(run.length / 3),
    })
  }
  const pages: (T | null | "blank")[][] = []
  let cur: (T | null | "blank")[] | null = null
  const fits = (p: (T | null | "blank")[], r: number, c: number, b: { w: number; h: number }) => {
    for (let y = r; y < r + b.h; y++) for (let x = c; x < c + b.w; x++) if (p[y * 3 + x] !== null) return false
    return true
  }
  for (const b of blocks) {
    let spot: [number, number] | null = null
    if (cur) {
      for (let r = 0; r + b.h <= 3 && !spot; r++)
        for (let c = 0; c + b.w <= 3 && !spot; c++) if (fits(cur, r, c, b)) spot = [r, c]
    }
    if (!spot || !cur) {
      if (cur) pages.push(cur)
      cur = Array<T | null | "blank">(9).fill(null)
      spot = [0, 0]
    }
    const page = cur
    const [r, c] = spot
    for (let y = r; y < r + b.h; y++) for (let x = c; x < c + b.w; x++) page[y * 3 + x] = "blank"
    b.cards.forEach((card, k) => {
      const y = b.col ? r + k : r + Math.floor(k / 3)
      const x = b.col ? c : c + (k % 3)
      page[y * 3 + x] = card
    })
  }
  if (cur) pages.push(cur)
  return pages.map((p) => p.map((cell) => (cell === "blank" ? null : cell)))
}
