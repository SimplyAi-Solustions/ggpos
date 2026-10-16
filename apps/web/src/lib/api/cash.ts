/**
 * The legacy cash-session reads (docs/api-contract.md, "Cash sessions").
 *
 * Cashing up now runs over the till routes (`lib/api/tillops.ts`,
 * docs/api-contract-epos.md, section 3): opening, movements and the Z all
 * went there, and their old calls went with them. What is left is the one
 * read Home, the old Sell screen and the buy-in wizard still make, which
 * the server answers for the default register. Demo mode answers the same
 * shape from memory.
 */
import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import * as demo from "@/lib/api/demo/cash"
import type {
  CashMovementRecord,
  CashSessionRecord,
  CashSessionState,
} from "@/lib/api/types"

interface SessionEnvelope {
  session: CashSessionRecord | null
  expected?: number
  movements?: CashMovementRecord[]
}

/** The open session, what the drawer should hold, and every movement on it. */
export async function getCurrentCashSession(): Promise<CashSessionState> {
  if (isDemo()) return demo.getCurrent()
  const result = await pb.send<SessionEnvelope>(
    "/api/vault/cash-sessions/current",
    { method: "GET" }
  )
  return {
    session: result.session,
    expected: result.expected ?? 0,
    movements: result.movements ?? [],
  }
}

/**
 * The open session's id, or null. The buy-in wizard needs it for a cash
 * payout, which the completion route refuses without one.
 */
export async function currentCashSessionId(): Promise<string | null> {
  const state = await getCurrentCashSession()
  return state.session?.id ?? null
}
