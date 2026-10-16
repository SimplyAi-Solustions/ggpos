/**
 * The stdio bridge against a stub of GG Vault's MCP endpoint: lines in,
 * the bearer token on every call, answers out one per line, nothing for a
 * notification, and a refused token or a dead server turned into JSON-RPC
 * errors for the requests that were waiting.
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { once } from "node:events"
import { createInterface } from "node:readline"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { endpointFrom, requestIds } from "../stdio.mjs"

const BRIDGE = fileURLToPath(new URL("../stdio.mjs", import.meta.url))
const TOKEN = "stub-agent-token"

/** A stub MCP endpoint that answers like GG Vault does and records what it was sent. */
async function stubServer() {
  const seen = []
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body })
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ status: 401, message: "The request requires valid record authorization token.", data: {} }))
        return
      }
      const message = JSON.parse(body)
      if (message.id === undefined) {
        res.writeHead(202)
        res.end()
        return
      }
      if (message.method === "explode") {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ status: 500, message: "Something went wrong on the server.", data: {} }))
        return
      }
      const result =
        message.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ggvault", version: "1.0.0" } }
          : message.method === "tools/list"
            ? { tools: [{ name: "stock_search", inputSchema: { type: "object" } }] }
            : {}
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address()
  return { server, seen, url: `http://127.0.0.1:${port}` }
}

/** Start the bridge; `send` writes a line, `next` reads the next answer. */
function bridge(env) {
  const child = spawn(process.execPath, [BRIDGE], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] })
  const answers = []
  const waiting = []
  let stderr = ""
  child.stderr.on("data", (chunk) => (stderr += chunk))
  createInterface({ input: child.stdout }).on("line", (line) => {
    const value = JSON.parse(line)
    const resolve = waiting.shift()
    if (resolve) resolve(value)
    else answers.push(value)
  })
  return {
    child,
    stderr: () => stderr,
    send: (value) => child.stdin.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`),
    next: () =>
      answers.length
        ? Promise.resolve(answers.shift())
        : new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`no answer; stderr: ${stderr}`)), 5000)
            waiting.push((value) => {
              clearTimeout(timer)
              resolve(value)
            })
          }),
    close: async () => {
      child.stdin.end()
      await once(child, "exit")
    },
  }
}

test("endpointFrom takes the server's address with or without the MCP path", () => {
  assert.equal(endpointFrom("https://ggpos.example.co.uk"), "https://ggpos.example.co.uk/api/vault/mcp")
  assert.equal(endpointFrom("https://ggpos.example.co.uk/"), "https://ggpos.example.co.uk/api/vault/mcp")
  assert.equal(endpointFrom("http://127.0.0.1:8091/api/vault/mcp"), "http://127.0.0.1:8091/api/vault/mcp")
  assert.equal(endpointFrom("ggpos.example.co.uk"), "")
  assert.equal(endpointFrom(undefined), "")
})

test("requestIds lists the requests in a message or a batch, never a notification", () => {
  assert.deepEqual(requestIds({ jsonrpc: "2.0", id: 1, method: "ping" }), [1])
  assert.deepEqual(requestIds({ jsonrpc: "2.0", method: "notifications/initialized" }), [])
  assert.deepEqual(
    requestIds([
      { jsonrpc: "2.0", id: "a", method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]),
    ["a", 2]
  )
})

test("forwards each line with the bearer token and writes each answer on its own line", async () => {
  const stub = await stubServer()
  const run = bridge({ GGVAULT_URL: stub.url, GGVAULT_TOKEN: TOKEN })
  try {
    run.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })
    const init = await run.next()
    assert.equal(init.id, 1)
    assert.equal(init.result.serverInfo.name, "ggvault")

    // A notification is posted but nothing comes back for it.
    run.send({ jsonrpc: "2.0", method: "notifications/initialized" })
    run.send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    const list = await run.next()
    assert.equal(list.id, 2)
    assert.equal(list.result.tools[0].name, "stock_search")

    assert.equal(stub.seen.length, 3)
    for (const call of stub.seen) {
      assert.equal(call.method, "POST")
      assert.equal(call.url, "/api/vault/mcp")
      assert.equal(call.auth, `Bearer ${TOKEN}`)
    }
    assert.equal(JSON.parse(stub.seen[1].body).method, "notifications/initialized")

    run.send("this is not json")
    const parse = await run.next()
    assert.equal(parse.error.code, -32700)

    run.send({ jsonrpc: "2.0", id: 3, method: "explode" })
    const broke = await run.next()
    assert.equal(broke.id, 3)
    assert.equal(broke.error.message, "Something went wrong on the server.")
  } finally {
    await run.close()
    stub.server.close()
  }
  assert.ok(!run.stderr().includes(TOKEN), "the token reached stderr")
})

test("a refused token answers each waiting request with an error that says what to do", async () => {
  const stub = await stubServer()
  const run = bridge({ GGVAULT_URL: stub.url, GGVAULT_TOKEN: "an-old-token" })
  try {
    run.send({ jsonrpc: "2.0", id: 7, method: "tools/list" })
    const refused = await run.next()
    assert.equal(refused.id, 7)
    assert.equal(refused.error.code, -32001)
    assert.match(refused.error.message, /give the agent a new one in Settings, Agents/)
  } finally {
    await run.close()
    stub.server.close()
  }
  assert.ok(!run.stderr().includes("an-old-token"), "the token reached stderr")
})

test("a server that does not answer is an error for the request, not a crash", async () => {
  const stub = await stubServer()
  const { url } = stub
  stub.server.close()
  await once(stub.server, "close")
  const run = bridge({ GGVAULT_URL: url, GGVAULT_TOKEN: TOKEN })
  try {
    run.send({ jsonrpc: "2.0", id: 9, method: "ping" })
    const dead = await run.next()
    assert.equal(dead.id, 9)
    assert.equal(dead.error.code, -32000)
    assert.match(dead.error.message, /Check GGVAULT_URL/)
  } finally {
    await run.close()
  }
})

test("without GGVAULT_URL or GGVAULT_TOKEN it says which and stops", async () => {
  const child = spawn(process.execPath, [BRIDGE], { env: { ...process.env, GGVAULT_URL: "", GGVAULT_TOKEN: "" } })
  let stderr = ""
  child.stderr.on("data", (chunk) => (stderr += chunk))
  const [code] = await once(child, "exit")
  assert.equal(code, 2)
  assert.match(stderr, /Set GGVAULT_URL/)
})
