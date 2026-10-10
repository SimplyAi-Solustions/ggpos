import { createFileRoute } from "@tanstack/react-router"

import { EstimateScreen } from "@/features/estimate/EstimateScreen"

function SignedInEstimate() {
  return <EstimateScreen signedIn />
}

export const Route = createFileRoute("/account/estimate")({
  component: SignedInEstimate,
})
