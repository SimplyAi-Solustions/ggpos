/**
 * The cash drawer, answered from memory. `expected` is computed exactly as
 * docs/api-contract.md defines it, so the demo variance is the real sum.
 */
import { DEMO_STAFF } from "@/lib/api/fixtures"
import {
  DEMO_SETTINGS,
  demoCashMovements,
  demoCashSessions,
  demoId,
  ensureSeeded,
} from "@/lib/api/demo/store"
import type {
  CashCloseResult,
  CashMovementRecord,
  CashMovementType,
  CashSessionRecord,
  CashSessionState,
} from "@/lib/api/types"

export function openSession(): CashSessionRecord | null {
  ensureSeeded()
  return demoCashSessions.find((session) => !session.closed_at) ?? null
}

/** float + cash sales + float_in - payouts - refunds - bank drops. */
export function expectedFor(sessionId: string): number {
  const session = demoCashSessions.find((row) => row.id === sessionId)
  if (!session) return 0
  return demoCashMovements
    .filter((movement) => movement.session === sessionId)
    .reduce((total, movement) => total + (movement.amount ?? 0), session.float ?? 0)
}

export function movementsFor(sessionId: string): CashMovementRecord[] {
  return demoCashMovements
    .filter((movement) => movement.session === sessionId)
    .sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""))
}

export function getCurrent(): CashSessionState {
  const session = openSession()
  return {
    session,
    expected: session ? expectedFor(session.id) : 0,
    movements: session ? movementsFor(session.id) : [],
  }
}

export function open(float: number): CashSessionRecord {
  ensureSeeded()
  if (openSession()) {
    throw new Error("A cash session is already open. Close it before opening another.")
  }
  const session: CashSessionRecord = {
    id: demoId("cash_session"),
    opened_by: DEMO_STAFF.id,
    openedByName: DEMO_STAFF.name,
    opened_at: new Date().toISOString(),
    float,
    notes: "",
  }
  demoCashSessions.unshift(session)
  return session
}

/** Every cash sale, payout, drop and correction the drawer saw. */
export function addMovement(
  sessionId: string,
  type: CashMovementType,
  amount: number,
  ref: string
): CashMovementRecord {
  const movement: CashMovementRecord = {
    id: demoId("cash_movement"),
    session: sessionId,
    type,
    amount,
    ref,
    staff: DEMO_STAFF.id,
    staffName: DEMO_STAFF.name,
    created: new Date().toISOString(),
  }
  demoCashMovements.unshift(movement)
  return movement
}

export function close(
  id: string,
  counted: number,
  notes: string
): CashCloseResult {
  ensureSeeded()
  const session = demoCashSessions.find((row) => row.id === id)
  if (!session) throw new Error("That cash session is not open.")
  if (session.closed_at) throw new Error("That cash session is already closed.")
  const expected = expectedFor(id)
  const variance = counted - expected
  session.expected = expected
  session.counted = counted
  session.variance = variance
  session.closed_by = DEMO_STAFF.id
  session.closedByName = DEMO_STAFF.name
  session.closed_at = new Date().toISOString()
  session.notes = notes
  return {
    session,
    expected,
    variance,
    // The server decides this, so the demo does too, from the same figure
    // the config route serves. Zero would mean no alert is configured.
    overAlert:
      DEMO_SETTINGS.cash_variance_alert > 0 &&
      Math.abs(variance) > DEMO_SETTINGS.cash_variance_alert,
  }
}

export function listSessions(): CashSessionRecord[] {
  ensureSeeded()
  return [...demoCashSessions].sort((a, b) =>
    (b.opened_at ?? "").localeCompare(a.opened_at ?? "")
  )
}
