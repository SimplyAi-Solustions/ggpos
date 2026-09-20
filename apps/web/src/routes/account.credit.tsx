import { createFileRoute } from "@tanstack/react-router"

import { CreditScreen } from "@/features/portal/CreditScreen"

export const Route = createFileRoute("/account/credit")({
  component: CreditScreen,
})
