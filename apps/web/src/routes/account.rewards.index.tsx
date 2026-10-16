import { createFileRoute } from "@tanstack/react-router"

import { RewardsScreen } from "@/features/portal/RewardsScreen"

export const Route = createFileRoute("/account/rewards/")({
  component: RewardsScreen,
})
