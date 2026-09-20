/**
 * The cash drawer. Opening, the running expected total, movements and the
 * close with its variance, over the three routes in docs/api-contract.md
 * ("Cash sessions"). Demo mode answers the same shapes from memory.
 */
import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import * as demo from "@/lib/api/demo/cash"
import type {
  CashMovementRecord,
  CashMovementType,
  CashSessionRecord,
  CashSessionState,
} from "@/lib/api/types"

export { DEMO_VARIANCE_ALERT } from "@/lib/api/demo/cash"

/** Opens the drawer with a counted float. 409 when one is already open. */
export async function openCashSession(float: number): Promise<CashSessionRecord> {
  if (isDemo()) return demo.open(float)
  return pb.send<CashSessionRecord>("/api/vault/cash-sessions/open", {
    method: "POST",
    body: { float },
  })
}

/** The open session, what the drawer should hold, and every movement on it. */
export async function getCurrentCashSession(): Promise<CashSessionState> {
  if (isDemo()) return demo.getCurrent()
  const result = await pb.send<{
    session: CashSessionRecord | null
    expected: number
    movements: CashMovementRecord[]
    variance_alert?: number
  }>("/api/vault/cash-sessions/current", { method: "GET" })
  return {
    session: result.session,
    expected: result.expected ?? 0,
    movements: result.movements ?? [],
    varianceAlert: result.variance_alert ?? 1000,
  }
}

/** Counts the drawer down and records the variance. */
export async function closeCashSession(
  id: string,
  counted: number,
  notes: string
): Promise<CashSessionRecord> {
  if (isDemo()) return demo.close(id, counted, notes)
  return pb.send<CashSessionRecord>(`/api/vault/cash-sessions/${id}/close`, {
    method: "POST",
    body: { counted, notes },
  })
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
 * create rule, not a route). A drop leaves the drawer, so it is negative; an
 * adjustment carries its own sign.
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
  return pb.collection("cash_sessions").getFullList<CashSessionRecord>({
    sort: "-opened_at",
    expand: "opened_by,closed_by",
    batch: limit,
  })
}
