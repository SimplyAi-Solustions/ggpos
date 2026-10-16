import { createFileRoute } from "@tanstack/react-router"

import { BuyInDraftScreen } from "@/features/tradein/BuyInDraftScreen"

function BuyInDraft() {
  const { id } = Route.useParams()
  return <BuyInDraftScreen id={id} />
}

export const Route = createFileRoute("/counter/trade/$id/")({
  component: BuyInDraft,
})
