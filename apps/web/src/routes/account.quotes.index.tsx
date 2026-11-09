import { createFileRoute, redirect } from "@tanstack/react-router"

import { offersEnabled } from "@/features/estimate/offers-flag"

import { QuotesScreen } from "@/features/portal/QuotesScreen"

export const Route = createFileRoute("/account/quotes/")({
  // Parked: send cards for an offer is off. See offers-flag.ts to turn it on.
  beforeLoad: () => {
    if (!offersEnabled()) throw redirect({ to: "/account/binders" })
  },
  component: QuotesScreen,
})
