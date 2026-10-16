import { beforeEach, describe, expect, it } from "vitest"
import { ClientResponseError } from "pocketbase"

import {
  DEMO_AGENT,
  demoCreateAgent,
  demoGetWebhook,
  demoListAgents,
  demoRekeyAgent,
  demoSaveWebhook,
  demoUpdateAgent,
  resetDemoAgents,
} from "@/lib/api/demo/agents"

/**
 * The demo shop's agents behave as the server does: a token answered once
 * on create and on re-key and never listed, a switched-off agent left with
 * no working token, and the webhook's secret never read back.
 */

beforeEach(() => {
  resetDemoAgents()
})

function refusal(run: () => unknown): { status: number; message: string } {
  try {
    run()
  } catch (error) {
    if (error instanceof ClientResponseError) return { status: error.status, message: error.message }
    throw error
  }
  throw new Error("expected a refusal")
}

describe("demo agents", () => {
  it("starts with Gandalf, an active admin with a working token", () => {
    const [gandalf] = demoListAgents()
    expect(gandalf?.id).toBe(DEMO_AGENT.id)
    expect(gandalf?.role).toBe("admin")
    expect(gandalf?.active).toBe(true)
    expect(gandalf?.token_expires_at).not.toBe("")
  })

  it("answers a new agent's token once, and never lists it", () => {
    const issued = demoCreateAgent({ name: "Radagast", note: "eBay research" })
    expect(issued.token.length).toBeGreaterThan(20)
    expect(issued.agent.name).toBe("Radagast")
    expect(JSON.stringify(demoListAgents())).not.toContain(issued.token)
  })

  it("refuses a missing or taken name in the server's words", () => {
    expect(refusal(() => demoCreateAgent({ name: "  " }))).toEqual({
      status: 400,
      message: "Give the agent a name of 60 characters or fewer.",
    })
    expect(refusal(() => demoCreateAgent({ name: "gandalf" }))).toEqual({
      status: 409,
      message: "There is already an agent called gandalf. Give this one another name.",
    })
  })

  it("leaves a switched-off agent with no token, and will not re-key it until it is on", () => {
    const off = demoUpdateAgent(DEMO_AGENT.id, { active: false })
    expect(off.active).toBe(false)
    expect(off.token_expires_at).toBe("")
    expect(refusal(() => demoRekeyAgent(DEMO_AGENT.id))).toEqual({
      status: 409,
      message: "Switch the agent on before giving it a new token.",
    })
    demoUpdateAgent(DEMO_AGENT.id, { active: true })
    expect(demoListAgents()[0]?.token_expires_at).toBe("")
    const issued = demoRekeyAgent(DEMO_AGENT.id)
    expect(issued.agent.token_expires_at).toBe(issued.expires_at)
  })

  it("keeps the webhook secret write-only", () => {
    expect(demoGetWebhook()).toEqual({ url: "", secret_set: false })
    const saved = demoSaveWebhook({ url: "http://mac-mini:8644/webhooks/ggvault", secret: "a-secret-of-twenty-chars" })
    expect(saved).toEqual({ url: "http://mac-mini:8644/webhooks/ggvault", secret_set: true })
    // A blank secret keeps the one set.
    expect(demoSaveWebhook({ url: "http://mac-mini:8644/webhooks/other" }).secret_set).toBe(true)
    expect(refusal(() => demoSaveWebhook({ url: "ftp://nope" })).status).toBe(400)
    expect(refusal(() => demoSaveWebhook({ url: "http://ok.example", secret: "short" })).status).toBe(400)
  })
})
