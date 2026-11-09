import { createFileRoute } from "@tanstack/react-router"

import { DealsPage } from "@/features/deals"
import { scanSearch } from "@/features/deals/scan-adds"

interface DealsSearch {
  /** `cards` ids sent by Scan with no deal open: a new draft is made for them. */
  add?: string
  condition?: string
}

export const Route = createFileRoute("/_app/deals/")({
  validateSearch: (search: Record<string, unknown>): DealsSearch => scanSearch(search),
  component: Deals,
})

function Deals() {
  const { add, condition } = Route.useSearch()
  return <DealsPage addFromScan={add ? { add, condition } : undefined} />
}
