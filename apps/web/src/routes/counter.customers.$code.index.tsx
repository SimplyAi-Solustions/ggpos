import { createFileRoute } from "@tanstack/react-router"

import { CustomerProfileScreen } from "@/features/customers/CustomerProfileScreen"

function CustomerProfile() {
  const { code } = Route.useParams()
  return <CustomerProfileScreen code={code} />
}

export const Route = createFileRoute("/counter/customers/$code/")({
  component: CustomerProfile,
})
