/**
 * The Cards and Scan screens' server calls. Search and the card page read
 * pb/pb_hooks/vault_scan.pb.js (database only, no adapter calls); research
 * and the custom price use the existing research and uk-comp routes.
 */
import { useQuery } from "@tanstack/react-query"

import { pb } from "@/lib/pb"

import type { GradingConfig } from "./grading"

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
  /** The games record id, for creating stock items. */
  game_id: string
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
  /** Items of this card still held: in stock, reserved or listed. 0 on rows without a price. */
  held: number
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

export interface HistoryRow {
  at: string
  pence: number
  source: string
  grader: string
  grade: string
  /** "" for a spot price; "avg1", "avg7" or "avg30" for a dated Cardmarket average. */
  basis: string
}

export interface GradedComp extends HistoryRow {
  url: string
}

export interface OpenRequest {
  id: string
  status: string
  condition: string
  grader: string
  grade: string
}

export interface CardDetail {
  card: CardRow
  market: { finish: string; chosen: PriceSourceRow | null; sources: PriceSourceRow[] }
  comps: CardComp[]
  history: HistoryRow[]
  /** Every graded snapshot of the card, any finish, newest first. */
  graded_comps: GradedComp[]
  held: number
  grading: GradingConfig
  /** ISO time the card was last snapshotted by the daily job or on demand, or null. */
  snapshotted_at: string | null
  versions: CardRow[]
  /** The live raw UK price check, if any. */
  research: OpenRequest | null
  /** Every live request on the card, graded ones included. */
  open_requests: OpenRequest[]
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

/** Asks the research queue for graded UK sold comps: "PSA 10" of this card. */
export function requestGradedCheck(cardId: string, finish: string, grader: string, grade: string) {
  return pb.send<{ request: { id: string; status: string }; existing?: boolean }>("/api/vault/research", {
    method: "POST",
    body: { card: cardId, finish, condition: "NM", grader, grade },
  })
}

export interface SnapshotResult {
  written: number
  seeded: number
  graded: number
  skipped: boolean
  ebay: "on" | "off"
  errors: string[]
}

/** Snapshots the card now through the adapters (vault_snapshots.pb.js). Rate limited server side: a repeat inside 20 hours is skipped. */
export function snapshotCard(cardId: string) {
  return pb.send<SnapshotResult>(`/api/vault/cardintel/cards/${encodeURIComponent(cardId)}/snapshot`, { method: "POST" })
}

/** Saves the grading fee config (managers and admins). */
export function saveGradingConfig(config: GradingConfig) {
  return pb.send<{ grading: GradingConfig }>("/api/vault/cardintel/grading", { method: "PUT", body: config })
}

/** A custom market price: a UK sold comp entered by staff, which leads every other source for 30 days. */
export function setUkMarketPrice(
  cardId: string,
  input: { finish: string; condition: string; price: number; url: string; sold_at: string; grader?: string; grade?: string }
) {
  return pb.send(`/api/vault/cards/${encodeURIComponent(cardId)}/uk-comp`, { method: "POST", body: input })
}

/** The message a failed call should show: the server's own sentence when it sent one. */
export function errorMessage(error: unknown, fallback: string): string {
  const e = error as { status?: number; response?: { message?: string } } | null
  if (e?.status === 0) return "Could not reach the server. Check the connection and try again."
  return e?.response?.message?.trim() || fallback
}
