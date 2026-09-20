import { createFileRoute } from "@tanstack/react-router"

import { StockListScreen } from "@/features/stock/StockListScreen"

export const Route = createFileRoute("/counter/stock/")({
  component: StockListScreen,
})
