import { createFileRoute } from "@tanstack/react-router"

import { DealDetailPage } from "@/features/deals"

interface DealSearch {
  /** A `cards` id sent by Scan, added to the deal on arrival. */
  add?: string
  condition?: string
}

export const Route = createFileRoute("/_app/deals/$id")({
  validateSearch: (search: Record<string, unknown>): DealSearch => ({
    add: typeof search.add === "string" && search.add ? search.add : undefined,
    condition: typeof search.condition === "string" && search.condition ? search.condition : undefined,
  }),
  component: DealDetail,
})

function DealDetail() {
  const { id } = Route.useParams()
  const { add, condition } = Route.useSearch()
  return <DealDetailPage id={id} addFromScan={add ? { cardId: add, condition } : undefined} />
}
