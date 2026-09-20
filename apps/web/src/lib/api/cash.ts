/**
 * The cash drawer. Opening, the running expected total, movements and the
 * close with its variance, over the three routes in docs/api-contract.md
 * ("Cash sessions" and its implementation notes). Demo mode answers the same
 * shapes from memory.
 *
 * `cash_movements.amount` is signed: cash sales and float in are positive,
 * payouts, refunds and bank drops negative, so the expected drawer total is
 * the float plus every movement and nothing has to know the sign rules twice.
 */
import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import * as demo from "@/lib/api/demo/cash"
import type {
  CashCloseResult,
  CashMovementRecord,
  CashMovementType,
  CashSessionRecord,
  CashSessionState,
} from "@/lib/api/types"

export { DEMO_VARIANCE_ALERT } from "@/lib/api/demo/cash"

/** The fallback when `settings` is out of reach: £10, as the seed sets it. */
const DEFAULT_VARIANCE_ALERT = 1000

interface SessionEnvelope {
  session: CashSessionRecord | null
  expected?: number
  movements?: CashMovementRecord[]
  variance?: number
  variance_alert?: boolean
}

let varianceAlert: number | null = null

/**
 * `settings` is admin-only and the cash routes do not carry the threshold, so
 * an admin reads it once and ordinary staff fall back to the seeded £10. The
 * close route decides the real alert either way; this only tints the figure.
 */
async function readVarianceAlert(): Promise<number> {
  if (varianceAlert !== null) return varianceAlert
  try {
    const row = await pb
      .collection("settings")
      .getFirstListItem<{ cash_variance_alert?: number }>("")
    varianceAlert = row.cash_variance_alert ?? DEFAULT_VARIANCE_ALERT
  } catch {
    varianceAlert = DEFAULT_VARIANCE_ALERT
  }
  return varianceAlert
}

/** Opens the drawer with a counted float. 409 when one is already open. */
export async function openCashSession(float: number): Promise<CashSessionRecord> {
  if (isDemo()) return demo.open(float)
  const result = await pb.send<SessionEnvelope>("/api/vault/cash-sessions/open", {
    method: "POST",
    body: { float },
  })
  if (!result.session) throw new Error("The drawer did not open. Try again.")
  return result.session
}

/** The open session, what the drawer should hold, and every movement on it. */
export async function getCurrentCashSession(): Promise<CashSessionState> {
  if (isDemo()) return demo.getCurrent()
  const [result, alert] = await Promise.all([
    pb.send<SessionEnvelope>("/api/vault/cash-sessions/current", { method: "GET" }),
    readVarianceAlert(),
  ])
  return {
    session: result.session,
    expected: result.expected ?? 0,
    movements: result.movements ?? [],
    varianceAlert: alert,
  }
}

/** Counts the drawer down and records the variance. */
export async function closeCashSession(
  id: string,
  counted: number,
  notes: string
): Promise<CashCloseResult> {
  if (isDemo()) return demo.close(id, counted, notes)
  const result = await pb.send<SessionEnvelope>(
    `/api/vault/cash-sessions/${id}/close`,
    { method: "POST", body: { counted, notes } }
  )
  if (!result.session) throw new Error("The drawer did not close. Count it again.")
  return {
    session: result.session,
    expected: result.expected ?? result.session.expected ?? 0,
    variance: result.variance ?? result.session.variance ?? 0,
    overAlert: result.variance_alert === true,
  }
}

/** Every movement on one session, newest first. */
export async function listCashMovements(
  sessionId: string
): Promise<CashMovementRecord[]> {
  if (isDemo()) return demo.movementsFor(sessionId)
  return pb.collection("cash_movements").getFullList<CashMovementRecord>({
    filter: `session = "${sessionId.replace(/["\\]/g, "\\$&")}"`,
    expand: "staff",
    sort: "-created",
  })
}

/**
 * A bank drop or a correction, written straight to `cash_movements` (a staff
 * create rule, not a route). `amount` carries its own sign: a drop leaves the
 * drawer, so the caller sends it negative.
 */
export async function addCashMovement(
  sessionId: string,
  type: CashMovementType,
  amount: number,
  ref: string
): Promise<CashMovementRecord> {
  if (isDemo()) return demo.addMovement(sessionId, type, amount, ref)
  return pb.collection("cash_movements").create<CashMovementRecord>({
    session: sessionId,
    type,
    amount,
    ref,
    staff: pb.authStore.record?.id,
  })
}

/** Today's session and the ones before it, for the history table. */
export async function listCashSessions(limit = 10): Promise<CashSessionRecord[]> {
  if (isDemo()) return demo.listSessions().slice(0, limit)
  const page = await pb.collection("cash_sessions").getList<CashSessionRecord>(1, limit, {
    sort: "-opened_at",
    expand: "opened_by,closed_by",
  })
  return page.items
}
