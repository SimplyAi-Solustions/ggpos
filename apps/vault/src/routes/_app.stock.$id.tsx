import { createFileRoute } from "@tanstack/react-router"

import { StockItemPage } from "@/features/stock"

export const Route = createFileRoute("/_app/stock/$id")({ component: StockItem })

function StockItem() {
  const { id } = Route.useParams()
  return <StockItemPage id={id} />
}
