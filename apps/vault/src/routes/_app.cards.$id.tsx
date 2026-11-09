import { createFileRoute } from "@tanstack/react-router"

import { CardDetailPage } from "@/features/cards"

export const Route = createFileRoute("/_app/cards/$id")({
  validateSearch: (search: Record<string, unknown>): { deal?: string } => ({
    deal: typeof search.deal === "string" && search.deal ? search.deal : undefined,
  }),
  component: CardDetail,
})

function CardDetail() {
  const { id } = Route.useParams()
  const { deal } = Route.useSearch()
  return <CardDetailPage key={id} id={id} dealId={deal} />
}
