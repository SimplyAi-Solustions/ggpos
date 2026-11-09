import { createFileRoute } from "@tanstack/react-router"

import { StockPage, type StockSearch } from "@/features/stock"

export const Route = createFileRoute("/_app/stock/")({
  validateSearch: (search: Record<string, unknown>): StockSearch => ({
    q: typeof search.q === "string" && search.q ? search.q : undefined,
    alert: typeof search.alert === "string" && search.alert ? search.alert : undefined,
  }),
  component: Stock,
})

function Stock() {
  const search = Route.useSearch()
  return <StockPage key={search.alert ?? ""} search={search} />
}
