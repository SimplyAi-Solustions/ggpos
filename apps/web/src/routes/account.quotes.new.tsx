import { createFileRoute, redirect } from "@tanstack/react-router"

import { offersEnabled } from "@/features/estimate/offers-flag"

import { NewQuoteScreen } from "@/features/portal/NewQuoteScreen"

export const Route = createFileRoute("/account/quotes/new")({
  // Parked: send cards for an offer is off. See offers-flag.ts to turn it on.
  beforeLoad: () => {
    if (!offersEnabled()) throw redirect({ to: "/account/binders" })
  },
  component: NewQuoteScreen,
})
