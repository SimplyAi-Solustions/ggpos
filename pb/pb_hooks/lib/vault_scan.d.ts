// Types for lib/vault_scan.js, so the vault app's tests can import it.
export interface ScanRead {
  game: string | null
  name_printed: string | null
  name_en: string | null
  set_code: string | null
  collector_number: string | null
  set_total: string | null
  promo_code: string | null
  language: string | null
  confidence: Record<string, number>
  [key: string]: unknown
}
export interface ScoreCard {
  id?: string
  name: string
  number: string
  set_code?: string
  set_name?: string
  set_total?: number | string | null
  release_date?: string
  game_key?: string
  language?: string
  name_en?: string
  set_abbr?: string
}
export interface ParsedQuery {
  number: string | null
  total: string | null
  code: string | null
  words: string[]
}
export interface Ranked {
  card: ScoreCard
  score: number
  why: string[]
}
export const HAIKU: string
export const SONNET: string
export const PROMPT: string
export function parseModelJson(text: string): unknown
export function cleanRead(raw: unknown): ScanRead
export function norm(s: unknown): string
export function num(s: unknown): string
export function distance(a: string, b: string, max: number): number
export function parseQuery(q: string): ParsedQuery
export function likeTerms(parsed: ParsedQuery): string[]
export function searchScore(parsed: ParsedQuery, card: ScoreCard): number
export function nameScore(read: ScanRead, card: ScoreCard): number
export function readNumber(read: ScanRead): string | null
export function readScore(read: ScanRead, card: ScoreCard): { score: number; why: string[] }
export function rankForRead(read: ScanRead, cards: ScoreCard[]): Ranked[]
export function needsDeepDive(read: ScanRead | null): boolean
export function agreement(read: ScanRead, ranked: Ranked[]): { accept: boolean; reasons: string[] }
export function variantTag(card: { name?: string; set_name?: string; rarity?: string; finish?: string; finishes?: string[] }): string
export function languageOf(ext: unknown, setExt: unknown): string
