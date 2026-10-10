import { createFileRoute } from "@tanstack/react-router"

import { QuotePage } from "@/features/quotes/QuotePage"

function Quote() {
  const { id } = Route.useParams()
  return <QuotePage id={id} />
}

export const Route = createFileRoute("/counter/quotes/$id")({
  component: Quote,
})
