import { createFileRoute } from "@tanstack/react-router"

import { DealsPage } from "@/features/deals"

export const Route = createFileRoute("/_app/deals/")({ component: DealsPage })
