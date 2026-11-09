import { createFileRoute } from "@tanstack/react-router"

import { EposPage } from "@/features/stock"

export const Route = createFileRoute("/_app/stock/epos")({ component: EposPage })
