import { createFileRoute } from "@tanstack/react-router"

import { CardLandingScreen } from "@/features/portal/CardLandingScreen"

function CardLanding() {
  const { token } = Route.useParams()
  return <CardLandingScreen token={token} />
}

/**
 * The QR landing on a customer's card. It never shows anything about a
 * customer without a sign-in; staff who are already signed in are taken to
 * that customer at the counter instead.
 */
export const Route = createFileRoute("/c/$token")({
  component: CardLanding,
})
