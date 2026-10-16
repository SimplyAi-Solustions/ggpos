import { createFileRoute } from "@tanstack/react-router"

import { TradeInListScreen } from "@/features/tradein/TradeInListScreen"

export const Route = createFileRoute("/counter/trade/")({
  component: TradeInListScreen,
})
