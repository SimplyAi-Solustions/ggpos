import { createFileRoute } from "@tanstack/react-router"

import { ShelfScreen } from "@/features/binders/ShelfScreen"

export const Route = createFileRoute("/account/binders/")({
  component: ShelfScreen,
})
