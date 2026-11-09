import { createFileRoute } from "@tanstack/react-router"

import { NewStockPage } from "@/features/stock"

export const Route = createFileRoute("/_app/stock/new")({
  validateSearch: (search: Record<string, unknown>): { card?: string } => ({
    card: typeof search.card === "string" && search.card ? search.card : undefined,
  }),
  component: NewStock,
})

function NewStock() {
  const { card } = Route.useSearch()
  return <NewStockPage key={card ?? ""} cardId={card} />
}
