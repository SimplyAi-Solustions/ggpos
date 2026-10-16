/**
 * Agents, GG Vault's own MCP endpoint, and research requests
 * (docs/api-contract-launch.md, section 5; docs/EPOS-PLAN.md, decision 10).
 *
 * Pure and shared by the hooks (through the generated CommonJS copy in
 * pb/pb_hooks/lib/shared/agents.js) and the web, so the search words a
 * staff member's "Search eBay sold" opens are the words an agent is woken
 * with, and the Hermes config the Agents screen hands out matches the
 * endpoint the server serves.
 */

/** How long an agent's token lasts: a year (the contract's "long-lived"). */
export const AGENT_TOKEN_DAYS = 365

/** The MCP endpoint, relative to the server's own address. */
export const MCP_PATH = "/api/vault/mcp"

/**
 * The name GG Vault gives itself in an MCP client's config. Hermes names a
 * server's tools `mcp_<server>_<tool>`, so this keeps them short and readable
 * (`mcp_ggvault_stock_search`).
 */
export const MCP_SERVER_NAME = "ggvault"

/** The event a new research request wakes an agent with. */
export const RESEARCH_EVENT = "research.requested"

// ---------------------------------------------------------------------------
// What the agent routes answer
// ---------------------------------------------------------------------------

/** One row of `GET /api/vault/agents`. Never a token, a hash or a key. */
export interface AgentSummary {
  id: string
  name: string
  note: string
  active: boolean
  /** Always admin: the shop chose full admin access for its agents. */
  role: string
  created: string
  /** When its current token was issued, or "" when it has none. */
  token_issued_at: string
  /** When that token stops working, or "". */
  token_expires_at: string
  /** Its newest audit row, or "" when it has done nothing yet. */
  last_action_at: string
}

/** `POST /api/vault/agents` and `POST /api/vault/agents/{id}/token`: shown once. */
export interface AgentTokenIssued {
  agent: AgentSummary
  token: string
  expires_at: string
}

/** One of an agent's last 50 actions, from the audit log. */
export interface AgentAction {
  id: string
  action: string
  collection: string
  record: string
  created: string
  /** A short line saying what it was, from the row's own identifiers. */
  detail: string
}

/** `GET /api/vault/agents/webhook`: the secret itself never leaves the server. */
export interface AgentWebhook {
  url: string
  secret_set: boolean
}

// ---------------------------------------------------------------------------
// Research requests
// ---------------------------------------------------------------------------

export const RESEARCH_STATUSES = ["open", "claimed", "done", "cancelled"] as const
export type ResearchStatus = (typeof RESEARCH_STATUSES)[number]

/** One sold listing an agent found. `price` is integer GBP pence. */
export interface ResearchComp {
  price: number
  currency: string
  /** YYYY-MM-DD. */
  sold_at: string
  url: string
  title: string
  condition: string
}

export interface ResearchPerson {
  id: string
  name: string
  kind: "person" | "agent"
}

/** `GET /api/vault/research` rows and every research route's answer. */
export interface ResearchRequest {
  id: string
  query: string
  status: ResearchStatus
  card: string
  retro_title: string
  item: string
  trade_in_line: string
  condition: string
  finish: string
  /** What it is about, in words: the card, the retro title, the item, or the query. */
  title: string
  requested_by: ResearchPerson | null
  claimed_by: ResearchPerson | null
  claimed_at: string
  result: string
  comps: ResearchComp[]
  done_at: string
  created: string
  updated: string
  /** ebay.co.uk's sold and completed listings for the query. */
  ebay_url: string
}

/** What the research list and the line's own block say about a request's state. */
export function researchStatusWords(request: Pick<ResearchRequest, "status" | "claimed_by" | "comps">): string {
  const who = request.claimed_by?.name ?? "An agent"
  if (request.status === "open") return "Waiting for an agent"
  if (request.status === "claimed") return `${who} is looking`
  if (request.status === "cancelled") return "Cancelled"
  const count = request.comps.length
  if (count === 0) return `${who} found nothing sold`
  return `${who} found ${count} sold`
}

// ---------------------------------------------------------------------------
// Search words and the eBay sold link
// ---------------------------------------------------------------------------

export interface ResearchSubject {
  /** The card's name, the retro title, or a free title. */
  name: string
  setName?: string
  number?: string
  /** A card's finish, or a retro title's completeness (loose, boxed, cib). */
  finish?: string
  /** NM to DMG for a card; unused for retro. */
  condition?: string
  kind?: "card" | "graded" | "retro" | "sealed" | "other"
  /** A graded card's company and grade, for example "PSA 10". */
  grade?: string
}

/** Finish words a seller actually puts in a title. A normal printing says nothing. */
const FINISH_WORDS: Record<string, string> = {
  holo: "holo",
  reverse: "reverse holo",
  reverse_holo: "reverse holo",
  reverseholo: "reverse holo",
  foil: "foil",
  first_edition: "1st edition",
  firstedition: "1st edition",
  "1st_edition": "1st edition",
}

/** Completeness words a UK retro listing uses. Loose is the default, so it says nothing. */
const COMPLETENESS_WORDS: Record<string, string> = {
  boxed: "boxed",
  cib: "complete",
}

function clean(text: string | undefined): string {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * The search words for a card, a retro title or a free title: its name, set
 * and number, and the condition word only where a seller would write it (a
 * graded card's grade, a holo or reverse finish, a boxed or complete game).
 * A near-mint or played raw card says nothing, because almost no sold
 * listing does.
 */
export function researchWords(subject: ResearchSubject): string {
  const parts: string[] = []
  const name = clean(subject.name)
  if (name) parts.push(name)
  const setName = clean(subject.setName)
  if (setName && !name.toLowerCase().includes(setName.toLowerCase())) parts.push(setName)
  const number = clean(subject.number)
  if (number && !name.includes(number)) parts.push(number)

  const finish = clean(subject.finish).toLowerCase()
  if (subject.kind === "retro") {
    const words = COMPLETENESS_WORDS[finish]
    if (words) parts.push(words)
  } else if (finish) {
    const words = FINISH_WORDS[finish.replace(/[\s-]/g, "_")]
    if (words && !name.toLowerCase().includes(words)) parts.push(words)
  }
  const grade = clean(subject.grade)
  if (subject.kind === "graded" && grade) parts.push(grade)

  return parts.join(" ").slice(0, 300)
}

/**
 * ebay.co.uk's sold and completed listings for some search words: sold
 * (`LH_Sold=1`), finished (`LH_Complete=1`), and from UK sellers only
 * (`LH_PrefLoc=1`), because a UK sold comp is a UK sale.
 */
export function ebaySoldUrl(words: string): string {
  const query = encodeURIComponent(clean(words)).replace(/%20/g, "+")
  return `https://www.ebay.co.uk/sch/i.html?_nkw=${query}&LH_Sold=1&LH_Complete=1&LH_PrefLoc=1`
}

/** The lowest and highest comp, in pence, or null with none. */
export function compRange(comps: readonly Pick<ResearchComp, "price">[]): { low: number; high: number } | null {
  const prices = comps.map((comp) => comp.price).filter((price) => Number.isInteger(price) && price > 0)
  if (!prices.length) return null
  return { low: Math.min(...prices), high: Math.max(...prices) }
}

// ---------------------------------------------------------------------------
// The Hermes config the Agents screen hands out
// ---------------------------------------------------------------------------

export interface HermesConfigInput {
  /** The server's own address, for example https://ggpos.ggentertainment.co.uk. */
  baseUrl: string
  token: string
  /** Where `services/mcp/stdio.mjs` lives on the agent's machine. */
  bridgePath?: string
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

/**
 * The `mcp_servers` block for Hermes's `config.yaml`, both ways: straight
 * to the MCP endpoint over HTTP with the token as the bearer, or through
 * the stdio bridge for a client that only runs local servers. Paste one.
 */
export function hermesConfig(input: HermesConfigInput): { http: string; stdio: string } {
  const base = input.baseUrl.replace(/\/+$/, "")
  const bridge = input.bridgePath || "/path/to/ggpos/services/mcp/stdio.mjs"
  const http = [
    "mcp_servers:",
    `  ${MCP_SERVER_NAME}:`,
    `    url: ${yamlString(base + MCP_PATH)}`,
    "    headers:",
    `      Authorization: ${yamlString(`Bearer ${input.token}`)}`,
    "    timeout: 120",
  ].join("\n")
  const stdio = [
    "mcp_servers:",
    `  ${MCP_SERVER_NAME}:`,
    '    command: "node"',
    `    args: [${yamlString(bridge)}]`,
    "    env:",
    `      GGVAULT_URL: ${yamlString(base)}`,
    `      GGVAULT_TOKEN: ${yamlString(input.token)}`,
  ].join("\n")
  return { http, stdio }
}
