import { createFileRoute } from "@tanstack/react-router"

import { LoyaltyScreen } from "@/features/loyalty/LoyaltyScreen"

export const Route = createFileRoute("/counter/loyalty")({
  component: LoyaltyScreen,
})
