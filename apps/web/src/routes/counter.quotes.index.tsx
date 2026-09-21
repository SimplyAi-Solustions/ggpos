import { createFileRoute } from "@tanstack/react-router"

import { QuotesScreen } from "@/features/quotes/QuotesScreen"

export const Route = createFileRoute("/counter/quotes/")({
  component: QuotesScreen,
})
