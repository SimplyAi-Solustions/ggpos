import { createFileRoute, notFound } from "@tanstack/react-router"

import { ReportScreen } from "@/features/reports/ReportScreen"
import { isReportKey } from "@/features/reports/specs"

function Report() {
  const { key } = Route.useParams()
  if (!isReportKey(key)) throw notFound()
  return <ReportScreen key={key} reportKey={key} />
}

export const Route = createFileRoute("/counter/reports/$key")({
  component: Report,
})
