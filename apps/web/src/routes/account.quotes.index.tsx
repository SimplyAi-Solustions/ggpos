import { createFileRoute } from "@tanstack/react-router"

import { QuotesScreen } from "@/features/portal/QuotesScreen"

export const Route = createFileRoute("/account/quotes/")({
  component: QuotesScreen,
})
