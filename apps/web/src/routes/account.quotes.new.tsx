import { createFileRoute } from "@tanstack/react-router"

import { NewQuoteScreen } from "@/features/portal/NewQuoteScreen"

export const Route = createFileRoute("/account/quotes/new")({
  component: NewQuoteScreen,
})
