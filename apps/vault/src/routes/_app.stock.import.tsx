import { createFileRoute } from "@tanstack/react-router"

import { ImportPage } from "@/features/stock"

export const Route = createFileRoute("/_app/stock/import")({ component: ImportPage })
