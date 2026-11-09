import { createFileRoute, redirect } from "@tanstack/react-router"

import { offersEnabled } from "@/features/estimate/offers-flag"

import { EstimateScreen } from "@/features/estimate/EstimateScreen"

function SignedInEstimate() {
  return <EstimateScreen signedIn />
}

export const Route = createFileRoute("/account/estimate")({
  // Parked: send cards for an offer is off. See offers-flag.ts to turn it on.
  beforeLoad: () => {
    if (!offersEnabled()) throw redirect({ to: "/account/binders" })
  },
  component: SignedInEstimate,
})
