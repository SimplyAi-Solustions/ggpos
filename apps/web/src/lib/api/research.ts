/**
 * Research requests (docs/api-contract-launch.md, section 5): a member of
 * staff asks for UK sold comps from a trade-in line, price check or the
 * item page, an agent claims and completes it, and the comps land as UK
 * sold comps on the card or retro title.
 *
 * Demo mode answers every call from `lib/api/demo/research.ts`, where the
 * demo agent Gandalf claims a new request and completes it a moment later,
 * so the whole loop can be walked with no server behind it.
 */
import type { ResearchComp, ResearchRequest, ResearchStatus } from "@gg/shared"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import * as demo from "@/lib/api/demo/research"

export type { ResearchComp, ResearchRequest, ResearchStatus }

/** What a request is about. Every field optional; the server fills the rest from the line or item. */
export interface ResearchInput {
  query?: string
  card?: string
  retro_title?: string
  item?: string
  trade_in_line?: string
  condition?: string
  /** A card's finish, or a retro title's completeness. */
  finish?: string
  /** Demo mode only: the words to title it by, which the server works out itself. */
  title?: string
}

export interface ResearchFilters {
  /** One status, or several joined with commas. */
  status?: string
  trade_in_line?: string
  item?: string
  card?: string
  retro_title?: string
}

export const researchKeys = {
  all: ["research"] as const,
  list: (filters: ResearchFilters) => ["research", "list", filters] as const,
  one: (id: string) => ["research", "one", id] as const,
}

/** How often an open or claimed request is read again while it is on screen. */
export function researchPollMs(): number {
  return isDemo() ? 700 : 5_000
}

/** Ask for research. `existing` is true when one about the same thing was already open. */
export async function createResearch(
  input: ResearchInput
): Promise<{ request: ResearchRequest; existing: boolean }> {
  if (isDemo()) return demo.demoCreateResearch(input)
  const { title: _title, ...body } = input
  void _title
  const result = await pb.send<{ request: ResearchRequest; existing?: boolean }>("/api/vault/research", {
    method: "POST",
    body,
  })
  return { request: result.request, existing: Boolean(result.existing) }
}

export async function listResearch(filters: ResearchFilters = {}): Promise<ResearchRequest[]> {
  if (isDemo()) return demo.demoListResearch(filters)
  const query: Record<string, string> = {}
  for (const [key, value] of Object.entries(filters)) {
    if (value) query[key] = value
  }
  const result = await pb.send<{ requests: ResearchRequest[] }>("/api/vault/research", {
    method: "GET",
    query,
  })
  return result.requests ?? []
}

export async function getResearch(id: string): Promise<ResearchRequest> {
  if (isDemo()) return demo.demoGetResearch(id)
  const result = await pb.send<{ request: ResearchRequest }>(
    `/api/vault/research/${encodeURIComponent(id)}`,
    { method: "GET" }
  )
  return result.request
}

export async function cancelResearch(id: string): Promise<ResearchRequest> {
  if (isDemo()) return demo.demoCancelResearch(id)
  const result = await pb.send<{ request: ResearchRequest }>(
    `/api/vault/research/${encodeURIComponent(id)}/cancel`,
    { method: "POST" }
  )
  return result.request
}

/** Still being looked at: worth reading again until it is done or cancelled. */
export function isLive(request: Pick<ResearchRequest, "status"> | null | undefined): boolean {
  return request?.status === "open" || request?.status === "claimed"
}
