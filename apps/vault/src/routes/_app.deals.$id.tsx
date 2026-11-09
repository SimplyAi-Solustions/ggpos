import { createFileRoute } from "@tanstack/react-router"

import { DealDetailPage } from "@/features/deals"

export const Route = createFileRoute("/_app/deals/$id")({ component: DealDetail })

function DealDetail() {
  const { id } = Route.useParams()
  return <DealDetailPage id={id} />
}
