import { createFileRoute } from "@tanstack/react-router"

import { CashScreen } from "@/features/cash/CashScreen"

export const Route = createFileRoute("/counter/cash")({
  component: CashScreen,
})
