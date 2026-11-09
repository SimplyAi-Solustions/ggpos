import { createFileRoute } from "@tanstack/react-router"

import { CardsPage } from "@/features/cards"

export const Route = createFileRoute("/_app/cards/")({ component: CardsPage })
