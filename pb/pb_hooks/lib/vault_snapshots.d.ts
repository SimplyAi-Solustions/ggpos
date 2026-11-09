// Types for the pure helpers in vault_snapshots.js, so apps/vault's tests
// (src/features/cards/snapshot-job.test.ts) can import them under TypeScript.

export const RUN_LIMIT: number
export const SNAPSHOT_TTL_HOURS: number
export const SCAN_WINDOW_DAYS: number
export const OPEN_DEAL_STATUSES: string[]
export const HELD_STATUSES: string[]

export interface CardPools {
  stock?: string[]
  deals?: string[]
  scans?: string[]
}

export interface SelectedCard {
  id: string
  reason: "stock" | "deals" | "scans"
}

export function selectCards(pools: CardPools, skip: string[], limit?: number | null): { cards: SelectedCard[]; total: number; capped: boolean }

export interface SeedPoint {
  basis: "avg1" | "avg7" | "avg30"
  daysAgo: number
  value: string
}

export function seedPoints(averages: Record<string, string | number | null | undefined> | null | undefined): SeedPoint[]
export function daysBefore(now: Date, days: number): string
export function pbDate(d: Date): string
export function ebayWords(card: { name: string; setName: string; number: string; finish: string }): string
