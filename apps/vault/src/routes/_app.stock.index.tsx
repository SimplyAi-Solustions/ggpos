import { createFileRoute } from "@tanstack/react-router"

import { StockPage } from "@/features/stock"

export const Route = createFileRoute("/_app/stock/")({ component: StockPage })
