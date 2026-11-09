import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Plus, Search } from "lucide-react"

import { cn } from "@/lib/cn"
import { Chip, Input, Sheet, Skeleton } from "@/ui"

import { searchCards } from "../api"
import { variantLabel } from "../format"
import { GAMES, type CardHit, type GameKey } from "../types"

export interface CardSearchSheetProps {
  open: boolean
  onClose: () => void
  onAdd: (hit: CardHit, variant: string) => void
}

const GAME_KEY = "gg-vault-deals-game"

function useDebounced<T>(value: T, ms: number): T {
  const [shown, setShown] = React.useState(value)
  React.useEffect(() => {
    const timer = window.setTimeout(() => setShown(value), ms)
    return () => window.clearTimeout(timer)
  }, [value, ms])
  return shown
}

/** Search the catalogue by name, set and number ("charizard 4/102", "sv151 199") and add a card. */
export function CardSearchSheet({ open, onClose, onAdd }: CardSearchSheetProps) {
  const [game, setGame] = React.useState<GameKey>(
    () => (localStorage.getItem(GAME_KEY) as GameKey | null) ?? "pokemon"
  )
  const [query, setQuery] = React.useState("")
  const [added, setAdded] = React.useState<string | null>(null)
  const debounced = useDebounced(query.trim(), 300)

  const results = useQuery({
    queryKey: ["deals", "card-search", game, debounced],
    queryFn: ({ signal }) => searchCards(game, debounced, signal),
    enabled: open && debounced.length >= 2,
    staleTime: 5 * 60_000,
  })

  const pickGame = (key: GameKey) => {
    setGame(key)
    localStorage.setItem(GAME_KEY, key)
  }

  const add = (hit: CardHit, variant: string) => {
    onAdd(hit, variant)
    setAdded(`${hit.id}:${variant}`)
    window.setTimeout(() => setAdded(null), 1200)
  }

  return (
    <Sheet open={open} onClose={onClose} title="Add a card" description="Search by name, set or number.">
      <div className="flex flex-col gap-3">
        <Input
          aria-label="Search cards"
          placeholder="charizard 4/102, sv151 199"
          leading={<Search aria-hidden />}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
          enterKeyHint="search"
          autoComplete="off"
        />
        <div className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 [scrollbar-width:none]">
          {GAMES.map((g) => (
            <Chip key={g.key} selected={g.key === game} onClick={() => pickGame(g.key)}>
              {g.label}
            </Chip>
          ))}
        </div>

        <div aria-live="polite" className="min-h-[200px]">
          {debounced.length < 2 ? (
            <p className="py-8 text-center text-sm text-fg-3">Type at least two letters.</p>
          ) : results.isPending ? (
            <div className="flex flex-col gap-3 py-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex gap-3">
                  <Skeleton className="h-[70px] w-[50px]" />
                  <Skeleton className="flex-1" lines={2} />
                </div>
              ))}
            </div>
          ) : results.isError ? (
            <p className="py-8 text-center text-sm text-pop-text" role="alert">
              Search did not answer. Check the connection and try again.
            </p>
          ) : results.data.length === 0 ? (
            <p className="py-8 text-center text-sm text-fg-2">
              No cards match "{debounced}". Check the spelling or number, or add it as a custom item.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {results.data.map((hit) => (
                <ResultRow key={hit.id} hit={hit} added={added} onAdd={add} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </Sheet>
  )
}

function ResultRow({
  hit,
  added,
  onAdd,
}: {
  hit: CardHit
  added: string | null
  onAdd: (hit: CardHit, variant: string) => void
}) {
  const finishes = hit.finishes.length ? hit.finishes : [""]
  return (
    <li className="flex gap-3 py-3">
      {hit.image ? (
        <img src={hit.image} alt="" width={50} height={70} loading="lazy" className="h-[70px] w-[50px] shrink-0 object-contain" />
      ) : (
        <div className="h-[70px] w-[50px] shrink-0 rounded-sm border border-dashed border-line-2" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{hit.name}</p>
        <p className="truncate font-mono text-xs text-fg-2 tnum">
          {[hit.setName, hit.number].filter(Boolean).join(" · ")}
        </p>
        {hit.rarity && <p className="truncate text-xs text-fg-3">{hit.rarity}</p>}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {finishes.map((finish) => {
            const done = added === `${hit.id}:${finish}`
            return (
              <button
                key={finish || "default"}
                type="button"
                onClick={() => onAdd(hit, finish)}
                aria-label={`Add ${hit.name}${finish ? `, ${variantLabel(finish)}` : ""}`}
                className={cn(
                  "inline-flex h-8 items-center gap-1 rounded-full px-3 text-xs font-semibold transition-colors duration-150",
                  done ? "bg-ok/15 text-ok" : "bg-volt text-on-volt hover:bg-volt-deep"
                )}
              >
                <Plus className="size-3.5" aria-hidden />
                {done ? "Added" : finish ? variantLabel(finish) : "Add"}
              </button>
            )
          })}
        </div>
      </div>
    </li>
  )
}
