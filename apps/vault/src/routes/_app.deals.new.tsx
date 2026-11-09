import { createFileRoute } from "@tanstack/react-router"

import { NewDealPage } from "@/features/deals"

export const Route = createFileRoute("/_app/deals/new")({ component: NewDealPage })
