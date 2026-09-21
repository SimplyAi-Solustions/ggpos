import { createFileRoute } from "@tanstack/react-router"

import { ExportsScreen } from "@/features/exports/ExportsScreen"

export const Route = createFileRoute("/counter/exports")({
  component: ExportsScreen,
})
