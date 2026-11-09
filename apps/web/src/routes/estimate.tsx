import { createFileRoute, redirect } from "@tanstack/react-router"

import { offersEnabled } from "@/features/estimate/offers-flag"

import { PublicEstimatePage } from "@/features/estimate/PublicEstimatePage"

/** Public, signed out, and the one page that drives sign-ups. */
export const Route = createFileRoute("/estimate")({
  // Parked: send cards for an offer is off. See offers-flag.ts to turn it on.
  beforeLoad: () => {
    if (!offersEnabled()) throw redirect({ to: "/account/binders" })
  },
  component: PublicEstimatePage,
})
