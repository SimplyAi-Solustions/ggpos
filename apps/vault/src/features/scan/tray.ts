/**
 * Batch scan: a running tray of cards scanned one after another, each with
 * the condition staff picked, then handed to Deals or Stock in one go. Kept
 * in sessionStorage so a page reload mid-batch does not lose the tray; a new
 * tab starts empty.
 */
import type { CardRow } from "@/features/cards/api"
import type { CardCondition } from "@/features/cards/condition-prices"

export const TRAY_KEY = "gg-vault-scan-tray"
export const TRAY_MAX = 60

export interface TrayLine {
  card: Pick<CardRow, "id" | "name" | "set_name" | "number" | "set_total" | "image_small" | "game_id" | "finishes">
  condition: CardCondition
  /** The condition's price at the time it was added, pence, or null. */
  pence: number | null
  qty: number
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">

function storage(): Store | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage
  } catch {
    return null
  }
}

export function readTray(store: Store | null = storage()): TrayLine[] {
  if (!store) return []
  try {
    const raw = store.getItem(TRAY_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as TrayLine[]).filter((l) => l && l.card && typeof l.card.id === "string" && l.qty > 0) : []
  } catch {
    return []
  }
}

export function writeTray(lines: readonly TrayLine[], store: Store | null = storage()): void {
  try {
    store?.setItem(TRAY_KEY, JSON.stringify(lines))
  } catch {
    // Storage blocked: the tray lives in memory for this page.
  }
}

/** The tray with one more of `card` at `condition`: a new line, or one more on the matching line. Pure. */
export function addLine(lines: readonly TrayLine[], card: TrayLine["card"], condition: CardCondition, pence: number | null): TrayLine[] {
  const index = lines.findIndex((l) => l.card.id === card.id && l.condition === condition)
  if (index >= 0) {
    return lines.map((l, i) => (i === index ? { ...l, qty: l.qty + 1, pence: pence ?? l.pence } : l))
  }
  if (lines.length >= TRAY_MAX) return [...lines]
  return [...lines, { card, condition, pence, qty: 1 }]
}

/** One fewer of a line; the line goes at zero. Pure. */
export function removeLine(lines: readonly TrayLine[], cardId: string, condition: CardCondition): TrayLine[] {
  return lines.map((l) => (l.card.id === cardId && l.condition === condition ? { ...l, qty: l.qty - 1 } : l)).filter((l) => l.qty > 0)
}

export function trayCount(lines: readonly TrayLine[]): number {
  return lines.reduce((sum, l) => sum + l.qty, 0)
}

/** The tray's market total, pence, counting only lines with a price. */
export function trayTotal(lines: readonly TrayLine[]): number {
  return lines.reduce((sum, l) => sum + (l.pence ?? 0) * l.qty, 0)
}

/** Every line flattened to one entry per unit, the shape the deal and stock hand-offs take. */
export function trayUnits(lines: readonly TrayLine[]): { cardId: string; condition: CardCondition }[] {
  const out: { cardId: string; condition: CardCondition }[] = []
  for (const l of lines) for (let i = 0; i < l.qty; i++) out.push({ cardId: l.card.id, condition: l.condition })
  return out
}
