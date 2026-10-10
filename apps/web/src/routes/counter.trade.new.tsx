import { createFileRoute } from "@tanstack/react-router"

import { BuyInWizard } from "@/features/tradein/BuyInWizard"

function NewBuyIn() {
  return <BuyInWizard />
}

export const Route = createFileRoute("/counter/trade/new")({
  component: NewBuyIn,
})
