import { createFileRoute } from "@tanstack/react-router"

import { LabelsPage } from "@/features/stock"

export const Route = createFileRoute("/_app/stock/labels")({ component: LabelsPage })
