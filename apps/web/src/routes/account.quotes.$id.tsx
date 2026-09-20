import { createFileRoute } from "@tanstack/react-router"

import { QuoteDetailScreen } from "@/features/portal/QuoteDetailScreen"

function QuoteDetail() {
  const { id } = Route.useParams()
  return <QuoteDetailScreen id={id} />
}

export const Route = createFileRoute("/account/quotes/$id")({
  component: QuoteDetail,
})
