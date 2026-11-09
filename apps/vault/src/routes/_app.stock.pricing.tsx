import { createFileRoute } from "@tanstack/react-router"

import { PricingPage } from "@/features/stock"

export const Route = createFileRoute("/_app/stock/pricing")({ component: PricingPage })
