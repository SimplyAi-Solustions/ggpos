/**
 * The demo till's register and cash session, in memory for the tab.
 *
 * Minimal on purpose: the cashing-up package grows it (X and Z reports,
 * movements, the running report). It starts open, so the demo till can sell
 * straight away, the way the demo counter always has.
 */
import type { NamedRef, TillCurrent, TillSession } from "@gg/shared"

import { DEMO_STAFF } from "@/lib/api/fixtures"

export const DEMO_REGISTER: NamedRef = { id: "register_demo", name: "Counter" }

function openedThisMorning(): string {
  const at = new Date()
  at.setHours(9, 0, 0, 0)
  return at.toISOString()
}

export const demoTill: { session: TillSession | null } = {
  session: {
    id: "till_session_demo",
    register: DEMO_REGISTER,
    opened_at: openedThisMorning(),
    opened_by: { id: DEMO_STAFF.id, name: DEMO_STAFF.name },
    float: 10000,
    opening_counts: null,
  },
}

export function getDemoTillCurrent(): TillCurrent {
  return { register: DEMO_REGISTER, session: demoTill.session, running: null }
}
