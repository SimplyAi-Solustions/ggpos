import { createFileRoute } from "@tanstack/react-router"

import { WantsScreen } from "@/features/portal/WantsScreen"

export const Route = createFileRoute("/account/wants")({
  component: WantsScreen,
})
