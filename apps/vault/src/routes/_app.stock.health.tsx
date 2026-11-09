import { createFileRoute } from "@tanstack/react-router"

import { HealthPage } from "@/features/stock"

export const Route = createFileRoute("/_app/stock/health")({ component: HealthPage })
