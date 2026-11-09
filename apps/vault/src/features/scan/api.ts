/**
 * POST /api/vault/scan/identify (pb/pb_hooks/vault_scan.pb.js): Claude Haiku
 * 5.5 reads the photo, Sonnet 5.5 rereads it when Haiku is unsure or when
 * staff ask for a deep dive, and the server ranks our own catalogue against
 * the read.
 */
import { pb } from "@/lib/pb"
import type { CardRow } from "@/features/cards/api"

export interface CardRead {
  game: string | null
  name_printed: string | null
  name_en: string | null
  set_code: string | null
  collector_number: string | null
  set_total: string | null
  promo_code: string | null
  rarity_mark: string | null
  finish: string | null
  language: string | null
  is_promo_stamped: boolean
  confidence: Record<string, number>
}

export interface Candidate extends CardRow {
  score: number
  why: string[]
}

export interface IdentifyResult {
  model: string
  escalated: boolean
  read: CardRead
  candidates: Candidate[]
  auto_accept: boolean
  reasons: string[]
}

export function identifyCard(image: string, deep: boolean, signal?: AbortSignal): Promise<IdentifyResult> {
  return pb.send<IdentifyResult>("/api/vault/scan/identify", {
    method: "POST",
    body: { image, deep },
    signal,
    // A Sonnet reread can take a few seconds; the SDK has no default timeout.
  })
}

/** "Claude Haiku 5.5" for the model id the server used. */
export function modelLabel(model: string): string {
  if (model.includes("sonnet")) return "Sonnet 5.5"
  if (model.includes("haiku")) return "Haiku 5.5"
  return model
}

/** What staff would type to find this card: the read name and number. */
export function searchTextFor(read: CardRead | null | undefined): string {
  if (!read) return ""
  const name = read.name_en || read.name_printed || ""
  const number = read.collector_number ? (read.set_total ? `${read.collector_number}/${read.set_total}` : read.collector_number) : ""
  return [name, number].filter(Boolean).join(" ")
}
