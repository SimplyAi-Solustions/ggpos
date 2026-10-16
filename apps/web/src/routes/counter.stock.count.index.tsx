import { createFileRoute } from "@tanstack/react-router"

import { StockCountStartScreen } from "@/features/stockcount/StockCountStartScreen"

export const Route = createFileRoute("/counter/stock/count/")({
  component: StockCountStartScreen,
})
