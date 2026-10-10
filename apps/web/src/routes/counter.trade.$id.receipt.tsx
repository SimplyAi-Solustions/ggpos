import { createFileRoute } from "@tanstack/react-router"

import { ReceiptScreen } from "@/features/tradein/ReceiptScreen"

function Receipt() {
  const { id } = Route.useParams()
  return <ReceiptScreen id={id} />
}

export const Route = createFileRoute("/counter/trade/$id/receipt")({
  component: Receipt,
})
