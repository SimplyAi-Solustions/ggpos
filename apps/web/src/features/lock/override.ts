/**
 * Manager approval at the till (docs/api-contract-epos.md, section 2,
 * "Overrides").
 *
 * A route that needs a capability the signed-in member lacks answers 403
 * `{ needs_override: true, capability }`. `withOverride` catches that, asks
 * for a manager's PIN through whatever approval screen is mounted (the
 * lock package's `OverrideHost`, which registers itself with
 * `setOverrideHandler`), and retries the same call with every token it has
 * collected in `X-GG-Override`, one approval per capability, until the call
 * succeeds or somebody cancels.
 *
 *   const sale = await withOverride(
 *     (headers) => completeSale(input, headers),
 *     { describe: (capability) => `Discount of £12.00` }
 *   )
 *
 * Cancelling rejects with `OverrideCancelled`, which a screen treats as
 * "nothing happened". With no approval screen mounted the original 403 is
 * rethrown, so the caller shows its sentence.
 */
import { ClientResponseError } from "pocketbase"
import { isCapability, type Capability } from "@gg/shared"

export const OVERRIDE_HEADER = "X-GG-Override"

export interface OverrideRequest {
  capability: Capability
  /** One line saying what is being approved, e.g. "Give a refund of £12.00". */
  description: string
  /** Sent to the server with the approval, for the audit row. */
  context?: { sale?: string; amount?: number; reason?: string }
}

/** Resolves to a single-use token, or null when the approval was cancelled. */
export type OverrideHandler = (request: OverrideRequest) => Promise<string | null>

let handler: OverrideHandler | null = null

/** Mounted by the approval screen; returns the unregister function. */
export function setOverrideHandler(next: OverrideHandler): () => void {
  handler = next
  return () => {
    if (handler === next) handler = null
  }
}

/** Ask for an approval directly. Null when cancelled or when nothing can ask. */
export async function requestOverride(request: OverrideRequest): Promise<string | null> {
  if (!handler) return null
  return handler(request)
}

export class OverrideCancelled extends Error {
  constructor() {
    super("Approval cancelled.")
    this.name = "OverrideCancelled"
  }
}

/** The capability a 403 asks approval for, or null when it is another refusal. */
export function neededCapability(error: unknown): Capability | null {
  if (!(error instanceof ClientResponseError) || error.status !== 403) return null
  const body = error.response as { needs_override?: unknown; capability?: unknown } | undefined
  if (body?.needs_override !== true) return null
  return isCapability(body.capability) ? body.capability : null
}

interface WithOverrideOptions {
  /** What is being approved, per capability. */
  describe?: (capability: Capability) => string
  context?: OverrideRequest["context"]
}

/** At most one approval per capability the action needs; there are only so many. */
const MAX_ROUNDS = 4

/**
 * Run `call`, and when the server asks for a manager's approval, get one and
 * run it again with the tokens.
 */
export async function withOverride<T>(
  call: (headers: Record<string, string>) => Promise<T>,
  options: WithOverrideOptions = {}
): Promise<T> {
  const tokens: string[] = []
  const asked = new Set<Capability>()
  for (let round = 0; ; round++) {
    const headers: Record<string, string> = tokens.length
      ? { [OVERRIDE_HEADER]: tokens.join(",") }
      : {}
    try {
      return await call(headers)
    } catch (error) {
      const capability = neededCapability(error)
      if (!capability || round >= MAX_ROUNDS || !handler) throw error
      // Asked for the same capability twice means the token we got did not
      // count (expired, or the approver lost the right); ask once more and
      // then let the refusal stand.
      if (asked.has(capability) && round >= 2) throw error
      asked.add(capability)
      const token = await requestOverride({
        capability,
        description: options.describe?.(capability) ?? "",
        context: options.context,
      })
      if (!token) throw new OverrideCancelled()
      tokens.push(token)
    }
  }
}
