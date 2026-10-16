import { createFileRoute, notFound } from "@tanstack/react-router"
import { z } from "zod"

import { ReportScreen } from "@/features/reports/ReportScreen"
import { isReportKey } from "@/features/reports/keys"

const searchSchema = z.object({
  /**
   * The dimension the table opens on, and for Sales by category the branch
   * drilled into: the dashboard's branches link here with `by=category`
   * and the branch (docs/api-contract-launch.md, section 3).
   */
  by: z.string().optional(),
  branch: z.string().optional(),
})

function Report() {
  const { key } = Route.useParams()
  const { by, branch } = Route.useSearch()
  // The guard below has already refused anything else, so this is safe.
  return isReportKey(key) ? (
    <ReportScreen key={`${key}:${by ?? ""}:${branch ?? ""}`} reportKey={key} initialBy={by} initialBranch={branch} />
  ) : null
}

export const Route = createFileRoute("/counter/reports/$key")({
  validateSearch: searchSchema,
  // An address that is not one of the nine reports is not a screen at all.
  beforeLoad: ({ params }) => {
    if (!isReportKey(params.key)) throw notFound()
  },
  component: Report,
})
