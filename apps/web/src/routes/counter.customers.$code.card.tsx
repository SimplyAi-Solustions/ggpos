import { createFileRoute } from "@tanstack/react-router"

import { CustomerCardScreen } from "@/features/customers/CustomerCardScreen"

function CustomerCard() {
  const { code } = Route.useParams()
  return <CustomerCardScreen code={code} />
}

export const Route = createFileRoute("/counter/customers/$code/card")({
  component: CustomerCard,
})
