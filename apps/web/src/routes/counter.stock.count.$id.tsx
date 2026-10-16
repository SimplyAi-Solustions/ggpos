import { createFileRoute } from "@tanstack/react-router"

import { StockCountScreen } from "@/features/stockcount/StockCountScreen"

export const Route = createFileRoute("/counter/stock/count/$id")({
  component: StockCountRoute,
})

function StockCountRoute() {
  const { id } = Route.useParams()
  return <StockCountScreen id={id} />
}
