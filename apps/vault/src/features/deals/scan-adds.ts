/**
 * Cards sent over from Scan and the batch tray (features/scan/addToDeal.ts):
 * `?add=a,b,b&condition=NM,LP,LP`, one entry per card, the condition by
 * position. A missing or unknown condition means NM.
 */
import { CONDITIONS, type CardHit, type Condition } from "./types"

export interface ScanAdd {
  cardId: string
  condition: Condition
  qty: number
}

/** More than this in one hand-off is a mistake, not a binder. */
export const MAX_SCAN_ADDS = 200

function list(value: unknown): string[] {
  if (value === undefined || value === null) return []
  return String(value)
    .split(",")
    .map((part) => part.trim())
}

/**
 * The cards to add, in the order sent. The same card in the same condition
 * twice becomes one line of two, as staff would key it by hand.
 */
export function parseScanAdds(add: unknown, condition?: unknown): ScanAdd[] {
  const ids = list(add).slice(0, MAX_SCAN_ADDS)
  const conditions = list(condition)
  const out: ScanAdd[] = []
  ids.forEach((cardId, i) => {
    if (!cardId) return
    const raw = (conditions[i] ?? "").toUpperCase()
    const cond = (CONDITIONS as readonly string[]).includes(raw) ? (raw as Condition) : "NM"
    const same = out.find((a) => a.cardId === cardId && a.condition === cond)
    if (same) same.qty += 1
    else out.push({ cardId, condition: cond, qty: 1 })
  })
  return out
}

/** The search params a route keeps, as plain strings (a numeric id must not become a number). */
export function scanSearch(search: Record<string, unknown>): { add?: string; condition?: string } {
  const text = (value: unknown) =>
    typeof value === "string" || typeof value === "number" ? String(value) || undefined : undefined
  return { add: text(search.add), condition: text(search.condition) }
}

export interface ScanAddOutcome {
  /** Units added, counting quantity. */
  added: number
  /** Cards the catalogue did not have. */
  missing: number
  /** Cards that failed to load for another reason (network, server). */
  failed: number
  /** The first failure, for the message. */
  error: unknown
  /** The name of the one card added, when it was one. */
  onlyName: string | null
}

/**
 * Loads each card once and adds it in the order sent. One card that cannot
 * be found never stops the rest.
 */
export async function addScannedCards(
  adds: readonly ScanAdd[],
  getCard: (id: string) => Promise<CardHit | null>,
  addCard: (hit: CardHit, variant: string, condition: Condition, qty: number) => void
): Promise<ScanAddOutcome> {
  const ids = [...new Set(adds.map((a) => a.cardId))]
  const loaded = await Promise.allSettled(ids.map((id) => getCard(id)))
  const cards = new Map(ids.map((id, i) => [id, loaded[i]!]))
  const outcome: ScanAddOutcome = { added: 0, missing: 0, failed: 0, error: null, onlyName: null }
  const names = new Set<string>()
  for (const add of adds) {
    const result = cards.get(add.cardId)!
    if (result.status === "rejected") {
      outcome.failed += add.qty
      outcome.error ??= result.reason
      continue
    }
    if (!result.value) {
      outcome.missing += add.qty
      continue
    }
    addCard(result.value, result.value.finishes[0] ?? "", add.condition, add.qty)
    outcome.added += add.qty
    names.add(result.value.name)
  }
  outcome.onlyName = outcome.added === 1 ? [...names][0]! : null
  return outcome
}
