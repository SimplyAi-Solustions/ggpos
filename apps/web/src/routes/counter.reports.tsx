import { createFileRoute } from "@tanstack/react-router"

import { Placeholder } from "@/app/placeholder"

function ReportsPlaceholder() {
  return (
    <Placeholder
      title="Reports"
      lede="Sales, buy-ins, margin and stock, each over a date range and against the period before it."
    />
  )
}

export const Route = createFileRoute("/counter/reports")({
  component: ReportsPlaceholder,
})
