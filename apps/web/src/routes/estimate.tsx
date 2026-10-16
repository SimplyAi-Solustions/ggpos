import { createFileRoute } from "@tanstack/react-router"

import { PublicEstimatePage } from "@/features/estimate/PublicEstimatePage"

/** Public, signed out, and the one page that drives sign-ups. */
export const Route = createFileRoute("/estimate")({
  component: PublicEstimatePage,
})
