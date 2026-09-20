import { createFileRoute } from "@tanstack/react-router"

import { PointsScreen } from "@/features/portal/PointsScreen"

export const Route = createFileRoute("/account/points")({
  component: PointsScreen,
})
