/**
 * Recent scans: the last 20 cards staff landed on from Scan, kept on this
 * device (localStorage) so a scan can be reopened without the photo. A card
 * scanned twice moves to the front rather than appearing twice.
 */
import type { CardRow } from "@/features/cards/api"

export const RECENT_SCANS_KEY = "gg-vault-recent-scans"
export const RECENT_SCANS_MAX = 20

export interface RecentScan {
  id: string
  name: string
  set_name: string
  number: string
  set_total: number | null
  image_small: string
  nm_pence: number | null
  /** ISO time of the scan. */
  at: string
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">

function storage(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

export function readRecentScans(store: Store | null = storage()): RecentScan[] {
  if (!store) return []
  try {
    const raw = store.getItem(RECENT_SCANS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e): e is RecentScan => Boolean(e && typeof e === "object" && typeof (e as RecentScan).id === "string")).slice(0, RECENT_SCANS_MAX)
  } catch {
    return []
  }
}

/** The list with `card` at the front, deduped and capped. Pure. */
export function withScan(list: readonly RecentScan[], card: Pick<CardRow, "id" | "name" | "set_name" | "number" | "set_total" | "image_small" | "nm_pence">, at: Date = new Date()): RecentScan[] {
  const entry: RecentScan = {
    id: card.id,
    name: card.name,
    set_name: card.set_name,
    number: card.number,
    set_total: card.set_total,
    image_small: card.image_small,
    nm_pence: card.nm_pence,
    at: at.toISOString(),
  }
  return [entry, ...list.filter((e) => e.id !== card.id)].slice(0, RECENT_SCANS_MAX)
}

export function rememberScan(card: Parameters<typeof withScan>[1], store: Store | null = storage()): RecentScan[] {
  const next = withScan(readRecentScans(store), card)
  try {
    store?.setItem(RECENT_SCANS_KEY, JSON.stringify(next))
  } catch {
    // Storage full or blocked: the list is still returned for this session.
  }
  return next
}

export function clearRecentScans(store: Store | null = storage()): void {
  try {
    store?.removeItem(RECENT_SCANS_KEY)
  } catch {
    // Nothing to clear.
  }
}
