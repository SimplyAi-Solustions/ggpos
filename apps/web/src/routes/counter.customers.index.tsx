import { createFileRoute } from "@tanstack/react-router"

import { Placeholder } from "@/app/placeholder"

function CustomersPlaceholder() {
  return (
    <Placeholder
      title="Customers"
      lede="Find a customer by name, phone or card, and see their trade-ins, credit and Guild points."
    />
  )
}

export const Route = createFileRoute("/counter/customers/")({
  component: CustomersPlaceholder,
})
