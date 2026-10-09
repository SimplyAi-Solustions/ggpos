/**
 * Capabilities and manager overrides in demo mode
 * (docs/api-contract-epos.md, section 2, "Overrides").
 *
 * The server answers a call the signed-in role cannot make with 403
 * `{ needs_override: true, capability }`, and takes it again with a
 * single-use token in `X-GG-Override`. The demo till routes do the same
 * here, against the demo settings' permissions table and the role of
 * whoever the demo session says is signed in, so the approval dialog can be
 * walked with no server behind it.
 */
import { ClientResponseError } from "pocketbase"
import { can, resolvePermissions, type Capability } from "@gg/shared"

import { demoSettings } from "@/lib/api/demo/settings"

const OVERRIDE_HEADER = "X-GG-Override"

interface Issued {
  capability: Capability
  approver: string
  expires: number
  used: boolean
}

const issued = new Map<string, Issued>()

/** Kept by the demo approval route; good for five minutes and one use. */
export function issueDemoOverride(token: string, capability: Capability, approver: string) {
  issued.set(token, { capability, approver, expires: Date.now() + 5 * 60_000, used: false })
}

/** The demo session's role, or null when nobody is signed in. */
export function demoSignedInRole(): string | null {
  try {
    const raw = localStorage.getItem("gg-demo-staff")
    return raw ? ((JSON.parse(raw) as { role?: string }).role ?? null) : null
  } catch {
    return null
  }
}

/**
 * Passes when the signed-in role holds the capability or the headers carry
 * an unused approval for it, which is then spent. Otherwise throws the
 * server's 403 so `withOverride` asks for a manager.
 */
export function demoRequire(capability: Capability, headers: Record<string, string> = {}): void {
  const table = resolvePermissions(demoSettings().epos?.permissions)
  if (can(demoSignedInRole(), capability, table)) return
  const tokens = (headers[OVERRIDE_HEADER] ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
  for (const token of tokens) {
    const grant = issued.get(token)
    if (grant && !grant.used && grant.capability === capability && grant.expires > Date.now()) {
      grant.used = true
      return
    }
  }
  throw new ClientResponseError({
    status: 403,
    response: {
      code: 403,
      message: "A manager needs to approve this.",
      needs_override: true,
      capability,
      data: {},
    },
  })
}

/** Tests only. */
export function resetDemoOverrides() {
  issued.clear()
}
