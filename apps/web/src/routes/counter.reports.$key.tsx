import { createFileRoute, notFound } from "@tanstack/react-router"

import { ReportScreen } from "@/features/reports/ReportScreen"
import { isReportKey } from "@/features/reports/specs"

function Report() {
  const { key } = Route.useParams()
  // The guard below has already refused anything else, so this is safe.
  return isReportKey(key) ? <ReportScreen key={key} reportKey={key} /> : null
}

export const Route = createFileRoute("/counter/reports/$key")({
  // An address that is not one of the nine reports is not a screen at all.
  beforeLoad: ({ params }) => {
    if (!isReportKey(params.key)) throw notFound()
  },
  component: Report,
})
