import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { NewCustomerScreen } from "@/features/customers/NewCustomerScreen"

const searchSchema = z.object({
  /** Carried over from the search box or the buy-in wizard. */
  name: z.string().optional(),
})

function NewCustomer() {
  const { name } = Route.useSearch()
  return <NewCustomerScreen initialName={name} />
}

export const Route = createFileRoute("/counter/customers/new")({
  validateSearch: searchSchema,
  component: NewCustomer,
})
