#!/usr/bin/env node
/**
 * GG Vault's MCP endpoint over stdio, for an MCP client that only runs
 * local servers (docs/agents.md).
 *
 * Reads JSON-RPC 2.0 messages from stdin, one per line, posts each to
 * GG Vault's own MCP endpoint (`POST /api/vault/mcp`) with the agent's
 * token as the bearer, and writes every answer to stdout, one per line.
 * A notification gets nothing back, as the protocol says. Nothing but
 * protocol goes to stdout; anything worth saying goes to stderr, and the
 * token never does.
 *
 *   GGVAULT_URL    the server's address, for example https://ggpos.ggentertainment.co.uk
 *   GGVAULT_TOKEN  the agent's token from Settings, Agents
 *
 * No dependencies: Node 20 or newer (fetch and AbortSignal.timeout).
 */
import { createInterface } from "node:readline"
import { realpathSync } from "node:fs"
import { pathToFileURL } from "node:url"

const MCP_PATH = "/api/vault/mcp"
const TIMEOUT_MS = 130_000

/** The endpoint from GGVAULT_URL, whether or not it already ends in the MCP path. */
export function endpointFrom(raw) {
  const base = String(raw ?? "").trim().replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(base)) return ""
  return base.endsWith(MCP_PATH) ? base : base + MCP_PATH
}

/** The ids of the requests in one message or a batch (notifications have none). */
export function requestIds(message) {
  const list = Array.isArray(message) ? message : [message]
  return list
    .filter((m) => m && typeof m === "object" && typeof m.method === "string" && m.id !== undefined && m.id !== null)
    .map((m) => m.id)
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } }
}

function say(text) {
  process.stderr.write(`[ggvault-mcp] ${text}\n`)
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

/** Forward one line; write whatever comes back. Never throws. */
async function forward(endpoint, token, line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    write(rpcError(null, -32700, "Parse error: that line is not JSON."))
    return
  }
  const ids = requestIds(message)
  const answerEach = (code, text) => {
    for (const id of ids) write(rpcError(id, code, text))
    if (!ids.length) say(text)
  }

  let res
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: line,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    answerEach(-32000, `GG Vault did not answer (${err?.name === "TimeoutError" ? "timed out" : "unreachable"}). Check GGVAULT_URL and the connection.`)
    return
  }

  if (res.status === 202 || res.status === 204) return
  const text = await res.text().catch(() => "")
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }

  if (res.status === 401 || res.status === 403) {
    const said = body && typeof body.message === "string" ? body.message : `GG Vault answered ${res.status}.`
    answerEach(-32001, `${said} The token was refused: give the agent a new one in Settings, Agents.`)
    return
  }
  // A JSON-RPC answer, success or error, goes back exactly as it came.
  if (body && (Array.isArray(body) || body.jsonrpc === "2.0")) {
    write(body)
    return
  }
  const said = body && typeof body.message === "string" ? body.message : `GG Vault answered ${res.status}.`
  answerEach(-32603, said)
}

export function main() {
  const endpoint = endpointFrom(process.env.GGVAULT_URL)
  const token = String(process.env.GGVAULT_TOKEN ?? "").trim()
  if (!endpoint) {
    say("Set GGVAULT_URL to GG Vault's address, for example https://ggpos.ggentertainment.co.uk.")
    process.exit(2)
  }
  if (!token) {
    say("Set GGVAULT_TOKEN to the agent's token from Settings, Agents.")
    process.exit(2)
  }

  const pending = new Set()
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on("line", (raw) => {
    const line = raw.trim()
    if (!line) return
    const job = forward(endpoint, token, line).finally(() => pending.delete(job))
    pending.add(job)
  })
  lines.on("close", async () => {
    await Promise.allSettled([...pending])
    process.exit(0)
  })
}

/** Run when started as a program, not when a test imports it. */
function startedDirectly() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href
  } catch {
    return false
  }
}

if (startedDirectly()) main()
