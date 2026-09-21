import { createFileRoute } from "@tanstack/react-router"

import { ItemPage } from "@/features/stock/ItemPage"

function Item() {
  const { sku } = Route.useParams()
  return <ItemPage sku={sku} />
}

export const Route = createFileRoute("/counter/stock/$sku")({
  component: Item,
})
