/**
 * The Cards and Scan screens' server calls. Search and the card page read
 * pb/pb_hooks/vault_scan.pb.js (database only, no adapter calls); research
 * and the custom price use the existing research and uk-comp routes.
 */
import { useQuery } from "@tanstack/react-query"

import { pb } from "@/lib/pb"

export type GameKey = "pokemon" | "mtg" | "onepiece" | "lorcana"

export const GAMES: { key: GameKey; label: string }[] = [
  { key: "pokemon", label: "Pokémon" },
  { key: "mtg", label: "Magic" },
  { key: "onepiece", label: "One Piece" },
  { key: "lorcana", label: "Lorcana" },
]

export interface GradedPrice {
  grader: string
  grade: string
  pence: number
}

export interface CardRow {
  id: string
  game: string
  game_name: string
  name: string
  number: string
  rarity: string
  set_id: string
  set_code: string
  set_name: string
  set_total: number | null
  release_date: string
  series: string
  image_small: string
  image_large: string
  finishes: string[]
  language: string
  variant: string
  illustrator: string
  nm_pence: number | null
  nm_source: string
  graded: GradedPrice[]
}

export interface PriceSourceRow {
  source: string
  gbp_market: number
  native_currency: string
  native_market: number
  fx_rate: number | null
  fx_date: string | null
  fetched_at: string
  stale: boolean
  evidence_url: string
}

export interface CardComp {
  id: string
  pence: number
  sold_at: string
  url: string
  title: string
  condition: string
  finish: string
}

export interface CardDetail {
  card: CardRow
  market: { finish: string; chosen: PriceSourceRow | null; sources: PriceSourceRow[] }
  comps: CardComp[]
  history: { at: string; pence: number; source: string }[]
  versions: CardRow[]
  research: { id: string; status: string; condition: string } | null
}

export async function searchCards(q: string, game: GameKey | "", signal?: AbortSignal): Promise<CardRow[]> {
  const query = q.trim()
  if (query.length < 2) return []
  const res = await pb.send<{ cards: CardRow[] }>("/api/vault/scan/cards", {
    method: "GET",
    query: game ? { q: query, game } : { q: query },
    signal,
  })
  return res.cards ?? []
}

export function useCardSearch(q: string, game: GameKey | "") {
  return useQuery({
    queryKey: ["vault-card-search", q.trim().toLowerCase(), game],
    queryFn: ({ signal }) => searchCards(q, game, signal),
    enabled: q.trim().length >= 2,
    staleTime: 60_000,
    placeholderData: (previous) => previous,
  })
}

export function getCardDetail(id: string, signal?: AbortSignal): Promise<CardDetail> {
  return pb.send<CardDetail>(`/api/vault/scan/cards/${encodeURIComponent(id)}`, { method: "GET", signal })
}

export function useCardDetail(id: string) {
  return useQuery({
    queryKey: ["vault-card", id],
    queryFn: ({ signal }) => getCardDetail(id, signal),
    staleTime: 60_000,
  })
}

/** Asks the research queue for UK sold comps (the existing route; an open twin is answered, not duplicated). */
export function requestUkPriceCheck(cardId: string, finish: string, condition = "NM") {
  return pb.send<{ request: { id: string; status: string }; existing?: boolean }>("/api/vault/research", {
    method: "POST",
    body: { card: cardId, finish, condition },
  })
}

/** A custom market price: a UK sold comp entered by staff, which leads every other source for 30 days. */
export function setUkMarketPrice(
  cardId: string,
  input: { finish: string; condition: string; price: number; url: string; sold_at: string }
) {
  return pb.send(`/api/vault/cards/${encodeURIComponent(cardId)}/uk-comp`, { method: "POST", body: input })
}

/** The message a failed call should show: the server's own sentence when it sent one. */
export function errorMessage(error: unknown, fallback: string): string {
  const e = error as { status?: number; response?: { message?: string } } | null
  if (e?.status === 0) return "Could not reach the server. Check the connection and try again."
  return e?.response?.message?.trim() || fallback
}
