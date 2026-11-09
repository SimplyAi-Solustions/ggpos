import { createFileRoute } from "@tanstack/react-router"

import { CardDetailPage } from "@/features/cards"

export const Route = createFileRoute("/_app/cards/$id")({ component: CardDetail })

function CardDetail() {
  const { id } = Route.useParams()
  return <CardDetailPage id={id} />
}
