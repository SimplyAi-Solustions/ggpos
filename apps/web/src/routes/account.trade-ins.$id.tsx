import { createFileRoute } from "@tanstack/react-router"

import { TradeInDetailScreen } from "@/features/portal/TradeInsScreen"

function TradeInDetail() {
  const { id } = Route.useParams()
  return <TradeInDetailScreen id={id} />
}

export const Route = createFileRoute("/account/trade-ins/$id")({
  component: TradeInDetail,
})
