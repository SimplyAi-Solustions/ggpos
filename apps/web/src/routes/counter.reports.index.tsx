import { createFileRoute } from "@tanstack/react-router"

import { ReportsIndexScreen } from "@/features/reports/ReportsIndexScreen"

export const Route = createFileRoute("/counter/reports/")({
  component: ReportsIndexScreen,
})
