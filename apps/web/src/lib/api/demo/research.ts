import { ClientResponseError } from "pocketbase"
import {
  DEFAULT_RETRO_PRIORITY,
  DEFAULT_TCG_PRIORITY,
  ebaySoldUrl,
  roundHalfUp,
  type ResearchComp,
  type ResearchRequest,
} from "@gg/shared"

import { DEMO_STAFF } from "@/lib/api/fixtures"
import * as catalogue from "@/lib/api/demo/catalogue"
import { DEMO_AGENT, demoNoteAgentAction } from "@/lib/api/demo/agents"
import type { ResearchFilters, ResearchInput } from "@/lib/api/research"

/**
 * Research requests in demo mode, answered from memory
 * (docs/api-contract-launch.md, section 5).
 *
 * The demo agent, Gandalf, does what the real one does on the shop's Mac
 * Mini, only faster: it claims a new request a moment after it is asked,
 * then completes it with three UK sold comps worked out from the demo price
 * book, each written as a UK sold comp on the card or retro title exactly as
 * a staff-entered comp is (`catalogue.addUkComp`), so the line's own price
 * sources pick it up. Nothing is kept past a reload.
 */

const CLAIM_AFTER_MS = 500
const COMPLETE_AFTER_MS = 1400
const DAY_MS = 24 * 60 * 60 * 1000

const NOTHING =
  "Say what to research: a card, a retro title, an item, a trade-in line or some search words."

function refuse(status: number, message: string): never {
  throw new ClientResponseError({ status, response: { code: status, message, data: {} } })
}

let counter = 0
function nextId(): string {
  counter += 1
  return `research_${Date.now().toString(36)}${counter}`
}

let listing = 204_500_000_000
function listingUrl(): string {
  listing += 7_919
  return `https://www.ebay.co.uk/itm/${listing}`
}

function day(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * DAY_MS).toISOString().slice(0, 10)
}

const ME = { id: DEMO_STAFF.id, name: DEMO_STAFF.name, kind: "person" as const }

function blank(partial: Partial<ResearchRequest> & Pick<ResearchRequest, "query">): ResearchRequest {
  const now = new Date().toISOString()
  return {
    id: nextId(),
    status: "open",
    card: "",
    retro_title: "",
    item: "",
    trade_in_line: "",
    condition: "",
    finish: "",
    title: partial.query,
    requested_by: ME,
    claimed_by: null,
    claimed_at: "",
    result: "",
    comps: [],
    done_at: "",
    created: now,
    updated: now,
    ebay_url: ebaySoldUrl(partial.query),
    ...partial,
  }
}

function seed(): ResearchRequest[] {
  const doneAt = new Date(Date.now() - 50 * 60_000).toISOString()
  const done = blank({
    query: "Mew ex Scarlet & Violet 151 205/165",
    title: "Mew ex · Scarlet & Violet 151 · 205/165",
    card: "card_sv151_205",
    finish: "normal",
    condition: "NM",
    status: "done",
    claimed_by: DEMO_AGENT,
    claimed_at: doneAt,
    done_at: doneAt,
    created: new Date(Date.now() - 62 * 60_000).toISOString(),
    result: "Three sold on eBay UK this week, all raw near-mint copies.",
    comps: [
      { price: 4150, currency: "GBP", sold_at: day(2), url: "https://www.ebay.co.uk/itm/204411122233", title: "Mew ex 205/165 Gold 151", condition: "Near mint" },
      { price: 3999, currency: "GBP", sold_at: day(4), url: "https://www.ebay.co.uk/itm/204411122299", title: "Pokemon 151 Mew ex 205 gold", condition: "Used" },
      { price: 4400, currency: "GBP", sold_at: day(6), url: "https://www.ebay.co.uk/itm/204411122311", title: "Mew EX 205/165 Scarlet Violet 151", condition: "Near mint" },
    ],
  })
  done.updated = doneAt
  const open = blank({
    query: "Pokemon 151 Elite Trainer Box sealed",
    created: new Date(Date.now() - 15 * 60_000).toISOString(),
  })
  return [open, done]
}

let requests: ResearchRequest[] = seed()

/** Tests put the demo back to its opening state. */
export function resetDemoResearch() {
  requests = seed()
}

function copy(request: ResearchRequest): ResearchRequest {
  return { ...request, comps: request.comps.map((comp) => ({ ...comp })) }
}

function find(id: string): ResearchRequest {
  const request = requests.find((row) => row.id === id)
  if (!request) refuse(404, "That research request was not found.")
  return request
}

/** The demo price book's figure for what is being researched, or a plain £15.00. */
function marketFor(request: ResearchRequest): number {
  try {
    if (request.card) {
      const view = catalogue.getPrices(request.card, request.finish, DEFAULT_TCG_PRIORITY, 1)
      if (view.chosen?.gbp_market) return view.chosen.gbp_market
    }
    if (request.retro_title) {
      const view = catalogue.getRetroPrices(request.retro_title, request.finish, DEFAULT_RETRO_PRIORITY)
      if (view.chosen?.gbp_market) return view.chosen.gbp_market
    }
  } catch {
    // Not in the price book: the plain figure below.
  }
  return 1500
}

/** Gandalf claims it, then a moment later completes it with three comps. */
function runDemoAgent(id: string) {
  globalThis.setTimeout(() => {
    const request = requests.find((row) => row.id === id)
    if (!request || request.status !== "open") return
    request.status = "claimed"
    request.claimed_by = DEMO_AGENT
    request.claimed_at = new Date().toISOString()
    request.updated = request.claimed_at
    demoNoteAgentAction(DEMO_AGENT.id, "research_claimed", "research_requests", id, "")
  }, CLAIM_AFTER_MS)

  globalThis.setTimeout(() => {
    const request = requests.find((row) => row.id === id)
    if (!request || request.status !== "claimed" || request.claimed_by?.id !== DEMO_AGENT.id) return
    const market = marketFor(request)
    const comps: ResearchComp[] = [
      { price: roundHalfUp(market * 1.03), sold_at: day(1), condition: "Near mint" },
      { price: roundHalfUp(market * 0.94), sold_at: day(4), condition: "Used" },
      { price: roundHalfUp(market * 0.99), sold_at: day(9), condition: "Near mint" },
    ].map((comp) => ({
      ...comp,
      currency: "GBP",
      url: listingUrl(),
      title: request.query,
    }))
    // Each comp written as a UK sold comp, exactly as a staff-entered one.
    for (const comp of comps) {
      if (request.card) {
        catalogue.addUkComp(request.card, { price: comp.price, url: comp.url, sold_at: comp.sold_at, finish: request.finish })
      } else if (request.retro_title) {
        catalogue.addUkComp(request.retro_title, {
          price: comp.price,
          url: comp.url,
          sold_at: comp.sold_at,
          completeness: request.finish || "loose",
        })
      }
    }
    const now = new Date().toISOString()
    request.status = "done"
    request.comps = comps
    request.result = "Three sold on eBay UK in the last fortnight. The newest leads the line's price."
    request.done_at = now
    request.updated = now
    demoNoteAgentAction(DEMO_AGENT.id, "research_completed", "research_requests", id, `${comps.length} comps`)
  }, COMPLETE_AFTER_MS)
}

/** A live request about the same thing, as the server matches it. */
function liveTwin(fields: ResearchRequest): ResearchRequest | undefined {
  return requests.find((row) => {
    if (row.status !== "open" && row.status !== "claimed") return false
    if (fields.trade_in_line) return row.trade_in_line === fields.trade_in_line
    if (fields.item) return row.item === fields.item
    if (fields.card || fields.retro_title) {
      return (
        !row.trade_in_line &&
        !row.item &&
        row.card === fields.card &&
        row.retro_title === fields.retro_title &&
        row.finish === fields.finish &&
        row.condition === fields.condition
      )
    }
    return !row.card && !row.retro_title && !row.item && !row.trade_in_line && row.query === fields.query
  })
}

export function demoCreateResearch(input: ResearchInput): { request: ResearchRequest; existing: boolean } {
  const query = String(input.query ?? input.title ?? "").replace(/\s+/g, " ").trim()
  if (!query) refuse(400, NOTHING)
  if (query.length > 300) refuse(400, "Keep the search words to 300 characters or fewer.")
  const draft = blank({
    query,
    title: String(input.title ?? "").trim() || query,
    card: input.card ?? "",
    retro_title: input.card ? "" : (input.retro_title ?? ""),
    item: input.item ?? "",
    trade_in_line: input.trade_in_line ?? "",
    finish: input.finish ?? "",
    condition: input.card ? input.condition || "NM" : "",
  })
  const twin = liveTwin(draft)
  if (twin) return { request: copy(twin), existing: true }
  requests.unshift(draft)
  runDemoAgent(draft.id)
  return { request: copy(draft), existing: false }
}

export function demoListResearch(filters: ResearchFilters = {}): ResearchRequest[] {
  const statuses = (filters.status ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
  return requests
    .filter((row) => !statuses.length || statuses.includes(row.status))
    .filter((row) => !filters.trade_in_line || row.trade_in_line === filters.trade_in_line)
    .filter((row) => !filters.item || row.item === filters.item)
    .filter((row) => !filters.card || row.card === filters.card)
    .filter((row) => !filters.retro_title || row.retro_title === filters.retro_title)
    .sort((a, b) => b.created.localeCompare(a.created))
    .map(copy)
}

export function demoGetResearch(id: string): ResearchRequest {
  return copy(find(id))
}

export function demoCancelResearch(id: string): ResearchRequest {
  const request = find(id)
  if (request.status === "done") refuse(409, "This request is done. Its comps are in the Research list.")
  if (request.status === "cancelled") refuse(409, "This request was cancelled. Ask again if it is still needed.")
  request.status = "cancelled"
  request.updated = new Date().toISOString()
  return copy(request)
}
