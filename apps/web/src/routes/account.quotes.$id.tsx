import { createFileRoute, redirect } from "@tanstack/react-router"

import { offersEnabled } from "@/features/estimate/offers-flag"

import { QuoteDetailScreen } from "@/features/portal/QuoteDetailScreen"

function QuoteDetail() {
  const { id } = Route.useParams()
  return <QuoteDetailScreen id={id} />
}

export const Route = createFileRoute("/account/quotes/$id")({
  // Parked: send cards for an offer is off. See offers-flag.ts to turn it on.
  beforeLoad: () => {
    if (!offersEnabled()) throw redirect({ to: "/account/binders" })
  },
  component: QuoteDetail,
})
