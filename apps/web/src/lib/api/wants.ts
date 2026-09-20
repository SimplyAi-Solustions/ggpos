/**
 * The want list: cards a customer is after, and the holds the shop puts on
 * an item when one comes in.
 *
 * All three calls are the Phase 5 routes. `GET /api/vault/want-list` sends
 * each row with its card already expanded and, on a matched row, the hold
 * as `{ until, price, title }`, so the screen never has to expand
 * `matched_item` itself or guess what is being held.
 */
import { pbCustomer } from "@/lib/pb-customer"
import { isDemo } from "@/lib/api/mode"
import { demoAddWant, demoCloseWant, demoListWants } from "@/lib/api/demo/portal"
import type {
  NewWantInput,
  WantHold,
  WantListRow,
  WantListStatus,
} from "@/lib/api/types"

/** One row as the route sends it. */
interface WantRowWire {
  id: string
  card?: { id: string; name: string; set: string; number: string } | null
  free_text?: string
  max_price?: number
  status?: WantListStatus
  hold?: { until: string; price: number; title: string } | null
  matched_item?: string
  notified_at?: string
  created?: string
  image?: string
}

function toHold(wire: WantRowWire["hold"]): WantHold | null {
  if (!wire || !wire.until) return null
  return { until: wire.until, price: wire.price ?? 0, title: wire.title ?? "" }
}

export function toWantRow(wire: WantRowWire): WantListRow {
  const card = wire.card ?? null
  return {
    id: wire.id,
    title: card?.name ?? wire.free_text ?? "Card",
    subtitle: card
      ? [card.set, card.number].filter(Boolean).join(" - ")
      : "Typed in by you",
    image: wire.image,
    maxPrice: wire.max_price ? wire.max_price : null,
    status: wire.status ?? "open",
    hold: toHold(wire.hold),
    created: wire.created ?? "",
  }
}

/**
 * Both the list and the two writes are read through this: the routes send
 * `{ rows }`, `{ row }` and (in an earlier draft) `{ want }`, so the reader
 * takes whichever is there rather than breaking on a wrapper name.
 */
function rowsFrom(result: unknown): WantRowWire[] {
  if (Array.isArray(result)) return result as WantRowWire[]
  const body = (result ?? {}) as Record<string, unknown>
  for (const key of ["rows", "items", "want_list", "wants"]) {
    const value = body[key]
    if (Array.isArray(value)) return value as WantRowWire[]
  }
  return []
}

function rowFrom(result: unknown): WantRowWire | null {
  const body = (result ?? {}) as Record<string, unknown>
  for (const key of ["row", "want", "want_list"]) {
    const value = body[key]
    if (value && typeof value === "object") return value as WantRowWire
  }
  // A bare record, with no wrapper at all.
  return typeof body.id === "string" ? (body as unknown as WantRowWire) : null
}

export async function listMyWants(): Promise<WantListRow[]> {
  if (isDemo()) return demoListWants()
  const result = await pbCustomer.send("/api/vault/want-list", { method: "GET" })
  return rowsFrom(result)
    .filter((row) => row.status !== "closed")
    .map(toWantRow)
}

export async function addWant(
  input: NewWantInput,
  display: { title: string; subtitle: string }
): Promise<WantListRow> {
  if (isDemo()) return demoAddWant(input, display.title, display.subtitle)

  const body: Record<string, unknown> = {}
  if (input.cardId) body.card = input.cardId
  if (input.freeText) body.free_text = input.freeText
  if (input.maxPrice !== null) body.max_price = input.maxPrice

  const result = await pbCustomer.send("/api/vault/want-list", {
    method: "POST",
    body,
  })
  const wire = rowFrom(result)
  if (!wire) throw new Error("That row could not be read back. Reload and check the list.")
  const row = toWantRow(wire)
  // The route expands the card, so its own title wins; the screen's is only
  // a fallback for a free-text row it already knows the words for.
  return {
    ...row,
    title: row.title || display.title,
    subtitle: row.subtitle || display.subtitle,
  }
}

export async function closeWant(id: string): Promise<void> {
  if (isDemo()) {
    demoCloseWant(id)
    return
  }
  await pbCustomer.send(`/api/vault/want-list/${id}/close`, { method: "POST" })
}
