import { createFileRoute } from "@tanstack/react-router"

import { DealDetailPage } from "@/features/deals"
import { scanSearch } from "@/features/deals/scan-adds"

interface DealSearch {
  /** `cards` ids sent by Scan, comma separated, added on arrival. */
  add?: string
  /** Their conditions by position; a missing one is NM. */
  condition?: string
}

export const Route = createFileRoute("/_app/deals/$id")({
  validateSearch: (search: Record<string, unknown>): DealSearch => scanSearch(search),
  component: DealDetail,
})

function DealDetail() {
  const { id } = Route.useParams()
  const { add, condition } = Route.useSearch()
  return <DealDetailPage id={id} addFromScan={add ? { add, condition } : undefined} />
}
