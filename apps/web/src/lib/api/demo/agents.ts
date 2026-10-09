import { ClientResponseError } from "pocketbase"
import { AGENT_TOKEN_DAYS, type AgentAction, type AgentSummary, type AgentTokenIssued, type AgentWebhook } from "@gg/shared"

/**
 * The demo shop's agents, answered from memory (docs/api-contract-launch.md,
 * section 5). Gandalf is already set up, with a token and a few things
 * done, so the Agents section reads like a shop that uses one; a new agent
 * gets a made-up token that is shown once, exactly as the server answers.
 * Nothing is kept past a reload.
 */

const DAY_MS = 24 * 60 * 60 * 1000

export const DEMO_AGENT = { id: "staff_agent_gandalf", name: "Gandalf", kind: "agent" as const }

interface DemoAgent extends AgentSummary {
  actions: AgentAction[]
}

const SENTENCES = {
  name: "Give the agent a name of 60 characters or fewer.",
  note: "Keep the note to 500 characters or fewer.",
  notFound: "That agent was not found.",
  off: "Switch the agent on before giving it a new token.",
  url: "Give the webhook an http or https address of 500 characters or fewer.",
  secret: "Make the webhook secret 16 to 200 characters, or leave it blank to keep the one set.",
}

function refuse(status: number, message: string): never {
  throw new ClientResponseError({ status, response: { code: status, message, data: {} } })
}

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

let counter = 0
function randomId(prefix: string): string {
  counter += 1
  return `${prefix}_${Date.now().toString(36)}${counter}`
}

function demoToken(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  let body = ""
  for (let i = 0; i < 48; i++) body += alphabet[Math.floor(Math.random() * alphabet.length)]
  return `demo.${body}`
}

function seedActions(): AgentAction[] {
  const rows: [string, string, string, number][] = [
    ["mcp_call", "mcp", "research_complete", 50 * 60_000],
    ["research_completed", "research_requests", "3 comps", 50 * 60_000],
    ["uk_comp", "price_snapshots", "£41.50", 50 * 60_000],
    ["mcp_call", "mcp", "research_claim", 55 * 60_000],
    ["mcp_call", "mcp", "research_list", 56 * 60_000],
    ["mcp_call", "mcp", "stock_search", 3 * 3_600_000],
    ["mcp_call", "mcp", "dashboard", 20 * 3_600_000],
  ]
  return rows.map(([action, collection, detail, age], index) => ({
    id: `demo_action_${index}`,
    action,
    collection,
    record: "",
    created: ago(age),
    detail,
  }))
}

function seed(): DemoAgent[] {
  const issued = ago(7 * DAY_MS)
  return [
    {
      id: DEMO_AGENT.id,
      name: DEMO_AGENT.name,
      note: "Hermes on the Mac Mini, through Buzz",
      active: true,
      role: "admin",
      created: issued,
      token_issued_at: issued,
      token_expires_at: new Date(new Date(issued).getTime() + AGENT_TOKEN_DAYS * DAY_MS).toISOString(),
      last_action_at: ago(50 * 60_000),
      actions: seedActions(),
    },
  ]
}

let agents: DemoAgent[] = seed()
let webhook = { url: "", secret: "" }

/** Tests put the demo back to its opening state. */
export function resetDemoAgents() {
  agents = seed()
  webhook = { url: "", secret: "" }
}

function summary(agent: DemoAgent): AgentSummary {
  const { actions: _actions, ...rest } = agent
  void _actions
  return { ...rest }
}

function find(id: string): DemoAgent {
  const agent = agents.find((row) => row.id === id)
  if (!agent) refuse(404, SENTENCES.notFound)
  return agent
}

function cleanName(raw: unknown): string {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim()
  if (!name || name.length > 60) refuse(400, SENTENCES.name)
  return name
}

function cleanNote(raw: unknown): string {
  const note = String(raw ?? "").trim()
  if (note.length > 500) refuse(400, SENTENCES.note)
  return note
}

function issue(agent: DemoAgent): AgentTokenIssued {
  const now = new Date()
  agent.token_issued_at = now.toISOString()
  agent.token_expires_at = new Date(now.getTime() + AGENT_TOKEN_DAYS * DAY_MS).toISOString()
  return { agent: summary(agent), token: demoToken(), expires_at: agent.token_expires_at }
}

export function demoListAgents(): AgentSummary[] {
  return [...agents].sort((a, b) => a.name.localeCompare(b.name)).map(summary)
}

export function demoCreateAgent(input: { name: string; note?: string }): AgentTokenIssued {
  const name = cleanName(input.name)
  const note = cleanNote(input.note)
  if (agents.some((row) => row.name.toLowerCase() === name.toLowerCase())) {
    refuse(409, `There is already an agent called ${name}. Give this one another name.`)
  }
  const agent: DemoAgent = {
    id: randomId("staff_agent"),
    name,
    note,
    active: true,
    role: "admin",
    created: new Date().toISOString(),
    token_issued_at: "",
    token_expires_at: "",
    last_action_at: "",
    actions: [],
  }
  agents.push(agent)
  return issue(agent)
}

export function demoUpdateAgent(id: string, patch: { name?: string; note?: string; active?: boolean }): AgentSummary {
  const agent = find(id)
  if (patch.name !== undefined) agent.name = cleanName(patch.name)
  if (patch.note !== undefined) agent.note = cleanNote(patch.note)
  if (patch.active !== undefined && patch.active !== agent.active) {
    agent.active = patch.active
    // Switching off rotates the key: the token it had never works again.
    if (!patch.active) {
      agent.token_issued_at = ""
      agent.token_expires_at = ""
    }
  }
  return summary(agent)
}

export function demoRekeyAgent(id: string): AgentTokenIssued {
  const agent = find(id)
  if (!agent.active) refuse(409, SENTENCES.off)
  return issue(agent)
}

export function demoAgentActions(id: string): AgentAction[] {
  return find(id).actions.slice(0, 50)
}

/** What the demo agent does is written to its own actions, newest first. */
export function demoNoteAgentAction(id: string, action: string, collection: string, record: string, detail: string) {
  const agent = agents.find((row) => row.id === id)
  if (!agent) return
  const created = new Date().toISOString()
  agent.actions.unshift({ id: randomId("demo_action"), action, collection, record, created, detail })
  agent.actions = agent.actions.slice(0, 50)
  agent.last_action_at = created
}

export function demoGetWebhook(): AgentWebhook {
  return { url: webhook.url, secret_set: webhook.secret !== "" }
}

export function demoSaveWebhook(input: { url: string; secret?: string; clear_secret?: boolean }): AgentWebhook {
  const url = String(input.url ?? "").trim()
  if (url && (url.length > 500 || !/^https?:\/\/[^\s/?#]+\S*$/i.test(url))) refuse(400, SENTENCES.url)
  const secret = String(input.secret ?? "").trim()
  if (secret && (secret.length < 16 || secret.length > 200)) refuse(400, SENTENCES.secret)
  webhook = { url, secret: input.clear_secret ? "" : secret || webhook.secret }
  return demoGetWebhook()
}
