import { createFileRoute } from "@tanstack/react-router"

import { CustomerListScreen } from "@/features/customers/CustomerListScreen"

export const Route = createFileRoute("/counter/customers/")({
  component: CustomerListScreen,
})
