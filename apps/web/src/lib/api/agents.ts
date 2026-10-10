/**
 * Agents (docs/api-contract-launch.md, section 5; docs/EPOS-PLAN.md,
 * decision 10): AI agents with full admin access, such as Gandalf on Buzz.
 *
 * Creating an agent and giving one a new token each answer the token once,
 * and both carry the admin's step-up. Switching one off stops its token at
 * once. The research webhook's secret is write-only: the server only ever
 * says whether one is set.
 *
 * Demo mode answers every call from `lib/api/demo/agents.ts`.
 */
import type { AgentAction, AgentSummary, AgentTokenIssued, AgentWebhook } from "@gg/shared"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import * as demo from "@/lib/api/demo/agents"

export type { AgentAction, AgentSummary, AgentTokenIssued, AgentWebhook }

const STEP_UP_HEADER = "X-Step-Up"

export const agentKeys = {
  all: ["agents"] as const,
  actions: (id: string) => ["agents", "actions", id] as const,
  webhook: ["agents", "webhook"] as const,
}

export async function listAgents(): Promise<AgentSummary[]> {
  if (isDemo()) return demo.demoListAgents()
  const result = await pb.send<{ agents: AgentSummary[] }>("/api/vault/agents", { method: "GET" })
  return result.agents ?? []
}

export async function createAgent(
  input: { name: string; note: string },
  stepUpToken: string
): Promise<AgentTokenIssued> {
  if (isDemo()) return demo.demoCreateAgent(input)
  return pb.send<AgentTokenIssued>("/api/vault/agents", {
    method: "POST",
    headers: { [STEP_UP_HEADER]: stepUpToken },
    body: input,
  })
}

export async function updateAgent(
  id: string,
  patch: { name?: string; note?: string; active?: boolean }
): Promise<AgentSummary> {
  if (isDemo()) return demo.demoUpdateAgent(id, patch)
  const result = await pb.send<{ agent: AgentSummary }>(`/api/vault/agents/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: patch,
  })
  return result.agent
}

/** A new token; the old one stops working the moment this answers. */
export async function rekeyAgent(id: string, stepUpToken: string): Promise<AgentTokenIssued> {
  if (isDemo()) return demo.demoRekeyAgent(id)
  return pb.send<AgentTokenIssued>(`/api/vault/agents/${encodeURIComponent(id)}/token`, {
    method: "POST",
    headers: { [STEP_UP_HEADER]: stepUpToken },
  })
}

export async function agentActions(id: string): Promise<AgentAction[]> {
  if (isDemo()) return demo.demoAgentActions(id)
  const result = await pb.send<{ actions: AgentAction[] }>(
    `/api/vault/agents/${encodeURIComponent(id)}/actions`,
    { method: "GET" }
  )
  return result.actions ?? []
}

export async function getAgentWebhook(): Promise<AgentWebhook> {
  if (isDemo()) return demo.demoGetWebhook()
  return pb.send<AgentWebhook>("/api/vault/agents/webhook", { method: "GET" })
}

/** A blank `secret` keeps the one set. */
export async function saveAgentWebhook(input: { url: string; secret?: string }): Promise<AgentWebhook> {
  if (isDemo()) return demo.demoSaveWebhook(input)
  return pb.send<AgentWebhook>("/api/vault/agents/webhook", { method: "POST", body: input })
}

/**
 * Where this GG Vault answers, for the Hermes config: the API's own base
 * resolved against the page (the app and the API share an origin in
 * production), without a trailing slash.
 */
export function vaultBaseUrl(): string {
  try {
    return new URL(pb.baseURL || "/", window.location.origin).href.replace(/\/+$/, "")
  } catch {
    return window.location.origin
  }
}

/** A webhook secret made in this browser: 40 letters and digits from the crypto source. */
export function makeWebhookSecret(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
  // Bytes at or over the last whole multiple of the alphabet are dropped,
  // so every character is equally likely.
  const limit = 256 - (256 % alphabet.length)
  let secret = ""
  while (secret.length < 40) {
    const bytes = new Uint8Array(64)
    crypto.getRandomValues(bytes)
    for (const byte of bytes) {
      if (byte < limit && secret.length < 40) secret += alphabet[byte % alphabet.length]
    }
  }
  return secret
}
