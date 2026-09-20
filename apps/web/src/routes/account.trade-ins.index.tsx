import { createFileRoute } from "@tanstack/react-router"

import { TradeInsScreen } from "@/features/portal/TradeInsScreen"

export const Route = createFileRoute("/account/trade-ins/")({
  component: TradeInsScreen,
})
