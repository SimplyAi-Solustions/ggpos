import { createFileRoute } from "@tanstack/react-router"

import { NewStockPage } from "@/features/stock"

export const Route = createFileRoute("/_app/stock/new")({ component: NewStockPage })
