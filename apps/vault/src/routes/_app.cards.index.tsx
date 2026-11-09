import * as React from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { CardsPage } from "@/features/cards"
import { GAMES, type GameKey } from "@/features/cards/api"

interface CardsSearch {
  q?: string
  game?: GameKey
}

export const Route = createFileRoute("/_app/cards/")({
  validateSearch: (search: Record<string, unknown>): CardsSearch => {
    const q = typeof search.q === "string" && search.q ? search.q.slice(0, 120) : undefined
    const game = GAMES.some((g) => g.key === search.game) ? (search.game as GameKey) : undefined
    return { q, game }
  },
  component: Cards,
})

function Cards() {
  const { q = "", game = "" } = Route.useSearch()
  const navigate = useNavigate({ from: "/cards/" })
  const onSearchChange = React.useCallback(
    (next: { q: string; game: GameKey | "" }) => {
      void navigate({ search: { q: next.q || undefined, game: next.game || undefined }, replace: true })
    },
    [navigate]
  )
  return <CardsPage q={q} game={game} onSearchChange={onSearchChange} />
}
