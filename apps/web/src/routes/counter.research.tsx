import { createFileRoute } from "@tanstack/react-router"

import { ResearchScreen } from "@/features/research/ResearchScreen"

/** The research requests for UK sold comps, for every member of staff. */
export const Route = createFileRoute("/counter/research")({
  component: ResearchScreen,
})
