/**
 * The reports dashboard (docs/api-contract-launch.md, section 3):
 * `GET /api/vault/reports/dashboard?from=&to=&compare=previous`, which needs
 * `reports_view`. Its shape is `Dashboard` in @gg/shared, which also adds it
 * up, so the demo answers in exactly the same shape.
 */
import type { Dashboard } from "@gg/shared"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { noteNetworkSuccess } from "@/lib/offline/net"
import { demoDashboard } from "@/lib/api/demo/dashboard"

export interface DashboardQuery {
  /** YYYY-MM-DD, both days included. */
  from: string
  to: string
  /** Ask for the period before as well. */
  compare: boolean
}

export async function getDashboard(query: DashboardQuery): Promise<Dashboard> {
  if (isDemo()) return demoDashboard(query)
  const body = await pb.send<Dashboard>("/api/vault/reports/dashboard", {
    method: "GET",
    query: { from: query.from, to: query.to, compare: query.compare ? "previous" : "none" },
  })
  noteNetworkSuccess()
  return body
}
