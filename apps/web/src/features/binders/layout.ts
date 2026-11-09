/**
 * Binder layout: where each card sits, which pockets are filled, and the
 * page operations, as pure functions over a small immutable state.
 *
 * Positions are absolute pocket indexes ("slots"): page = floor(slot / per
 * page). Switching the grid size reflows the same order onto bigger or
 * smaller pages. A slot of -1 means the card was taken out of the binder but
 * kept, so an undo can put it back.
 *
 * Every action returns a new Layout; the screen keeps them in a History for
 * undo and redo, and sends diffLayouts(prev, next) to the server.
 */

export type Grid = "2x2" | "3x3" | "3x4" | "4x4"

export const GRIDS: Record<Grid, { cols: number; rows: number; label: string }> = {
  "2x2": { cols: 2, rows: 2, label: "4 pocket" },
  "3x3": { cols: 3, rows: 3, label: "9 pocket" },
  "3x4": { cols: 3, rows: 4, label: "12 pocket" },
  "4x4": { cols: 4, rows: 4, label: "16 pocket" },
}

export const GRID_ORDER: Grid[] = ["2x2", "3x3", "3x4", "4x4"]

export function gridOf(value: string | null | undefined): Grid {
  return value && value in GRIDS ? (value as Grid) : "3x3"
}

export function perPage(grid: Grid): number {
  const g = GRIDS[grid]
  return g.cols * g.rows
}

export interface Layout {
  /** Pocket id to slot; -1 means taken out. */
  slots: Readonly<Record<string, number>>
  owned: Readonly<Record<string, boolean>>
  /** Pocket capacity the customer asked for with Add page. */
  minSlots: number
}

export interface Placed {
  id: string
  slot: number
  owned: boolean
}

/**
 * Builds a layout from the server's pockets. Two pockets claiming one slot
 * (only possible through a hand-made API call) are settled here: the later
 * one by id moves to the next free slot, so the grid never draws two cards
 * in one pocket.
 */
export function layoutFrom(pockets: readonly Placed[], minSlots = 0): Layout {
  const slots: Record<string, number> = {}
  const owned: Record<string, boolean> = {}
  const taken = new Set<number>()
  const sorted = [...pockets].sort((a, b) => a.slot - b.slot || (a.id < b.id ? -1 : 1))
  const bumped: string[] = []
  for (const p of sorted) {
    owned[p.id] = !!p.owned
    if (p.slot < 0) {
      slots[p.id] = -1
    } else if (taken.has(p.slot)) {
      bumped.push(p.id)
    } else {
      slots[p.id] = p.slot
      taken.add(p.slot)
    }
  }
  let next = 0
  for (const id of bumped) {
    while (taken.has(next)) next++
    slots[id] = next
    taken.add(next)
  }
  return { slots, owned, minSlots: Math.max(0, minSlots) }
}

/** The highest slot in use, or -1 for an empty binder. */
export function maxSlot(layout: Layout): number {
  let m = -1
  for (const id in layout.slots) if (layout.slots[id] > m) m = layout.slots[id]
  return m
}

export function pageCount(layout: Layout, grid: Grid): number {
  const pp = perPage(grid)
  return Math.max(1, Math.ceil(Math.max(layout.minSlots, maxSlot(layout) + 1) / pp))
}

export type Filter = "all" | "owned" | "needed"

export interface Cell<T> {
  /** The pocket's real slot, or -1 for padding on a filtered page. */
  slot: number
  pocket: T | null
}

/**
 * Lays pockets onto pages. "all" draws the binder as it is, gaps included;
 * "owned" and "needed" draw just those cards, packed in binder order, since
 * a page of mostly empty pockets helps nobody find a card.
 */
export function buildPages<T extends { id: string }>(
  pockets: readonly T[],
  layout: Layout,
  grid: Grid,
  filter: Filter
): Cell<T>[][] {
  const pp = perPage(grid)
  if (filter === "all") {
    const bySlot = new Map<number, T>()
    for (const p of pockets) {
      const s = layout.slots[p.id]
      if (s !== undefined && s >= 0) bySlot.set(s, p)
    }
    const n = pageCount(layout, grid)
    const pages: Cell<T>[][] = []
    for (let pg = 0; pg < n; pg++) {
      const cells: Cell<T>[] = []
      for (let i = 0; i < pp; i++) {
        const slot = pg * pp + i
        cells.push({ slot, pocket: bySlot.get(slot) ?? null })
      }
      pages.push(cells)
    }
    return pages
  }
  const want = filter === "owned"
  const list = pockets
    .filter((p) => {
      const s = layout.slots[p.id]
      return s !== undefined && s >= 0 && !!layout.owned[p.id] === want
    })
    .sort((a, b) => layout.slots[a.id] - layout.slots[b.id])
  const pages: Cell<T>[][] = []
  for (let i = 0; i < list.length; i += pp) {
    const cells: Cell<T>[] = list.slice(i, i + pp).map((p) => ({ slot: layout.slots[p.id], pocket: p }))
    while (cells.length < pp) cells.push({ slot: -1, pocket: null })
    pages.push(cells)
  }
  if (!pages.length) pages.push(Array.from({ length: pp }, () => ({ slot: -1, pocket: null })))
  return pages
}

/** The page a slot sits on, for jumping to a card after a move. */
export function pageOfSlot(slot: number, grid: Grid): number {
  return slot < 0 ? 0 : Math.floor(slot / perPage(grid))
}

/** After a grid change, the page that shows the first card the old page showed. */
export function reflowPage(page: number, from: Grid, to: Grid): number {
  return Math.floor((page * perPage(from)) / perPage(to))
}

// ---------- actions ----------

export function setOwned(layout: Layout, ids: readonly string[], owned: boolean): Layout {
  const next = { ...layout.owned }
  let changed = false
  for (const id of ids) {
    if (id in layout.slots && !!next[id] !== owned) {
      next[id] = owned
      changed = true
    }
  }
  return changed ? { ...layout, owned: next } : layout
}

/** Takes cards out of their pockets. They are kept at slot -1 for undo. */
export function clearPockets(layout: Layout, ids: readonly string[]): Layout {
  const next = { ...layout.slots }
  let changed = false
  for (const id of ids) {
    if (id in next && next[id] >= 0) {
      next[id] = -1
      changed = true
    }
  }
  return changed ? { ...layout, slots: next } : layout
}

/**
 * Moves the chosen cards, in binder order, into the pockets starting at
 * `target`. A card already in one of those pockets swaps into a pocket the
 * moving cards left behind, so nothing is ever dropped or doubled up.
 */
export function movePockets(layout: Layout, ids: readonly string[], target: number): Layout {
  const moving = ids
    .filter((id) => id in layout.slots && layout.slots[id] >= 0)
    .sort((a, b) => layout.slots[a] - layout.slots[b])
  if (!moving.length || target < 0) return layout
  const movingSet = new Set(moving)
  const dest = moving.map((_, i) => target + i)
  const destSet = new Set(dest)
  const occupant = new Map<number, string>()
  for (const id in layout.slots) occupant.set(layout.slots[id], id)
  // Pockets the moving cards free up, outside the destination run.
  const freed = moving.map((id) => layout.slots[id]).filter((s) => !destSet.has(s))
  const displaced = dest
    .map((s) => occupant.get(s))
    .filter((id): id is string => id !== undefined && !movingSet.has(id))
  const next = { ...layout.slots }
  moving.forEach((id, i) => {
    next[id] = dest[i]
  })
  displaced.forEach((id, i) => {
    next[id] = freed[i]
  })
  const same = moving.every((id, i) => layout.slots[id] === dest[i])
  return same ? layout : { ...layout, slots: next }
}

/** Puts an empty page in at `at` (default: after the last page). */
export function addPage(layout: Layout, grid: Grid, at?: number): Layout {
  const pp = perPage(grid)
  const n = pageCount(layout, grid)
  const where = at === undefined ? n : Math.max(0, Math.min(n, at))
  const start = where * pp
  const slots: Record<string, number> = {}
  for (const id in layout.slots) {
    const s = layout.slots[id]
    slots[id] = s >= start ? s + pp : s
  }
  return { ...layout, slots, minSlots: (n + 1) * pp }
}

/**
 * Takes a page out of the binder. Its cards are kept at slot -1 so an undo
 * restores them; later pages close up the gap. The last page never goes.
 */
export function removePage(layout: Layout, grid: Grid, page: number): Layout {
  const pp = perPage(grid)
  const n = pageCount(layout, grid)
  if (n <= 1 || page < 0 || page >= n) return layout
  const start = page * pp
  const end = start + pp
  const slots: Record<string, number> = {}
  for (const id in layout.slots) {
    const s = layout.slots[id]
    slots[id] = s < 0 ? s : s >= end ? s - pp : s >= start ? -1 : s
  }
  return { ...layout, slots, minSlots: (n - 1) * pp }
}

/** Moves page `from` so it becomes page `to`; the pages between shift along. */
export function movePage(layout: Layout, grid: Grid, from: number, to: number): Layout {
  const pp = perPage(grid)
  const n = pageCount(layout, grid)
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return layout
  const order = Array.from({ length: n }, (_, i) => i)
  order.splice(to, 0, ...order.splice(from, 1))
  const newIndex = new Array<number>(n)
  order.forEach((old, i) => {
    newIndex[old] = i
  })
  const slots: Record<string, number> = {}
  for (const id in layout.slots) {
    const s = layout.slots[id]
    if (s < 0) {
      slots[id] = s
      continue
    }
    const pg = Math.floor(s / pp)
    slots[id] = pg < n ? newIndex[pg] * pp + (s % pp) : s
  }
  return { ...layout, slots, minSlots: Math.max(layout.minSlots, n * pp) }
}

// ---------- persistence ----------

export interface LayoutDiff {
  pockets: { id: string; slot?: number; owned?: boolean }[]
  min_slots?: number
}

export function diffLayouts(a: Layout, b: Layout): LayoutDiff {
  const pockets: LayoutDiff["pockets"] = []
  for (const id in b.slots) {
    const change: { id: string; slot?: number; owned?: boolean } = { id }
    if (a.slots[id] !== b.slots[id]) change.slot = b.slots[id]
    if (!!a.owned[id] !== !!b.owned[id]) change.owned = !!b.owned[id]
    if (change.slot !== undefined || change.owned !== undefined) pockets.push(change)
  }
  const out: LayoutDiff = { pockets }
  if (a.minSlots !== b.minSlots) out.min_slots = b.minSlots
  return out
}

export function isEmptyDiff(d: LayoutDiff): boolean {
  return d.pockets.length === 0 && d.min_slots === undefined
}

// ---------- undo and redo ----------

export interface History {
  past: Layout[]
  present: Layout
  future: Layout[]
}

export const HISTORY_LIMIT = 100

export function initHistory(present: Layout): History {
  return { past: [], present, future: [] }
}

/** Records a new state. A no-op action leaves the history alone. */
export function commit(h: History, next: Layout): History {
  if (next === h.present) return h
  const past = [...h.past, h.present]
  if (past.length > HISTORY_LIMIT) past.shift()
  return { past, present: next, future: [] }
}

export function undo(h: History): History {
  if (!h.past.length) return h
  const past = h.past.slice(0, -1)
  return { past, present: h.past[h.past.length - 1], future: [h.present, ...h.future] }
}

export function redo(h: History): History {
  if (!h.future.length) return h
  const [next, ...future] = h.future
  return { past: [...h.past, h.present], present: next, future }
}

// ---------- stats ----------

export interface StatPocket {
  id: string
  set_id: string
  set_name: string
  set_total: string
  number: string
}

export interface SetProgress {
  set_id: string
  set_name: string
  got: number
  total: number
}

export interface BinderStatsV2 {
  filled: number
  total: number
  /** Main set progress for a set binder: numbered cards up to the printed total. */
  mainSet: { got: number; total: number } | null
  /** Per set progress for every other binder, most complete first. */
  sets: SetProgress[]
  setsComplete: number
}

export function binderStats(pockets: readonly StatPocket[], layout: Layout, kind: string): BinderStatsV2 {
  let filled = 0
  let total = 0
  const bySet = new Map<string, SetProgress>()
  let mainGot = 0
  let mainTotal = 0
  for (const p of pockets) {
    const s = layout.slots[p.id]
    if (s === undefined || s < 0) continue
    const got = !!layout.owned[p.id]
    total++
    if (got) filled++
    if (p.set_id) {
      let sp = bySet.get(p.set_id)
      if (!sp) {
        sp = { set_id: p.set_id, set_name: p.set_name, got: 0, total: 0 }
        bySet.set(p.set_id, sp)
      }
      sp.total++
      if (got) sp.got++
    }
    if (kind === "set") {
      const printed = /^\d+$/.test(p.set_total) ? Number(p.set_total) : 0
      const n = /^\d+$/.test(p.number) ? Number(p.number) : NaN
      if (printed && n >= 1 && n <= printed) {
        mainTotal++
        if (got) mainGot++
      }
    }
  }
  const sets = [...bySet.values()].sort(
    (a, b) => b.got / b.total - a.got / a.total || b.total - a.total || a.set_name.localeCompare(b.set_name)
  )
  return {
    filled,
    total,
    mainSet: kind === "set" && mainTotal ? { got: mainGot, total: mainTotal } : null,
    sets,
    setsComplete: sets.filter((s) => s.total > 0 && s.got === s.total).length,
  }
}

// ---------- no prices, ever ----------

/** Any key that smells of money. Mirrors pb/pb_hooks/lib/binders_v2.js. */
export const PRICE_KEY = /(pric|cost|value|market|pence|amount|gbp|eur|usd|tcgplayer|cardmarket|offer|payout|margin)/i

/**
 * Drops every price-like key at any depth. The server already strips them;
 * this is the second lock, so nothing the binder screens draw can carry a
 * value even if a response changes shape.
 */
export function stripPrices<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripPrices(v)) as T
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PRICE_KEY.test(k)) continue
      out[k] = stripPrices(v)
    }
    return out as T
  }
  return value
}
