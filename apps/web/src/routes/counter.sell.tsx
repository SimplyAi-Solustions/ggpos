import { createFileRoute } from "@tanstack/react-router"

import { SellScreen } from "@/features/sell/SellScreen"

export const Route = createFileRoute("/counter/sell")({
  component: SellScreen,
})
