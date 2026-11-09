import * as React from "react"
import { Link } from "@tanstack/react-router"
import { ScanLine, Search, SearchX, X } from "lucide-react"

import { buttonClasses, Chip, EmptyState, IconButton, Input, PageHeader, Skeleton } from "@/ui"

import { errorMessage, GAMES, useCardSearch, type GameKey } from "./api"
import { CardResultRow, GradedRow } from "./CardResultRow"

export interface CardsPageProps {
  q: string
  game: GameKey | ""
  /** Writes the query and game back to the address, replacing the entry. */
  onSearchChange: (next: { q: string; game: GameKey | "" }) => void
}

const EXAMPLES = ["umbreon vmax", "215/203", "s6a 095", "OP05-119", "charizard 4/102"]

export function CardsPage({ q, game, onSearchChange }: CardsPageProps) {
  const [text, setText] = React.useState(q)
  const [debounced, setDebounced] = React.useState(q)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(text), 180)
    return () => window.clearTimeout(timer)
  }, [text])

  React.useEffect(() => {
    if (debounced !== q) onSearchChange({ q: debounced, game })
  }, [debounced, q, game, onSearchChange])

  const search = useCardSearch(debounced, game)
  const results = search.data ?? []
  const searching = debounced.trim().length >= 2

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Catalogue"
        title="Cards"
        actions={
          <Link to="/scan" className={buttonClasses("secondary", "sm")}>
            <ScanLine className="size-4" aria-hidden />
            Scan
          </Link>
        }
      >
        Name, number, set code or a bit of each. Typos are fine.
      </PageHeader>

      <div className="flex flex-col gap-3">
        <Input
          ref={inputRef}
          aria-label="Search cards"
          type="search"
          inputMode="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Umbreon VMAX, 215/203, s6a 095"
          value={text}
          onChange={(event) => setText(event.target.value)}
          leading={<Search className="size-5 text-fg-3" aria-hidden />}
          trailing={
            text ? (
              <IconButton
                label="Clear search"
                size="sm"
                onClick={() => {
                  setText("")
                  inputRef.current?.focus()
                }}
              >
                <X />
              </IconButton>
            ) : null
          }
        />
        <div role="group" aria-label="Game" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:mx-0 md:px-0">
          <Chip selected={game === ""} onClick={() => onSearchChange({ q: debounced, game: "" })}>
            All games
          </Chip>
          {GAMES.map((g) => (
            <Chip key={g.key} selected={game === g.key} onClick={() => onSearchChange({ q: debounced, game: g.key })}>
              {g.label}
            </Chip>
          ))}
        </div>
      </div>

      {!searching ? (
        <div className="flex flex-col gap-3 pt-2">
          <p className="label-mono text-fg-3">Try</p>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setText(example)}
                className="h-9 rounded-full border border-dashed border-line-2 px-3.5 font-mono text-[13px] text-fg-2 transition-colors hover:border-fg-3 hover:text-fg"
              >
                {example}
              </button>
            ))}
          </div>
        </div>
      ) : search.isError ? (
        <EmptyState icon={<SearchX aria-hidden />} title="Search failed">
          {errorMessage(search.error, "The catalogue did not answer. Check the connection and try again.")}
        </EmptyState>
      ) : search.isPending ? (
        <ul aria-label="Loading results" className="flex flex-col gap-2">
          {Array.from({ length: 5 }, (_, i) => (
            <li key={i} className="flex items-center gap-3 px-2 py-2">
              <Skeleton className="h-[67px] w-12 rounded-sm" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
              <Skeleton className="h-5 w-16" />
            </li>
          ))}
        </ul>
      ) : results.length === 0 ? (
        <EmptyState icon={<SearchX aria-hidden />} title="No cards found" action={<Link to="/scan" className={buttonClasses("secondary", "md")}>Scan the card instead</Link>}>
          Nothing matches &ldquo;{debounced.trim()}&rdquo;{game ? ` in ${GAMES.find((g) => g.key === game)?.label}` : ""}. Check the number, or try the set code and number.
        </EmptyState>
      ) : (
        <section aria-label="Results" className="flex flex-col">
          <p className="label-mono mb-1 px-2 text-fg-3" aria-live="polite">
            {results.length} {results.length === 1 ? "card" : "cards"}
          </p>
          <ul className={search.isFetching ? "opacity-70 transition-opacity" : "transition-opacity"}>
            {results.map((card) => (
              <React.Fragment key={card.id}>
                <CardResultRow card={card} />
                {card.graded.map((g) => (
                  <GradedRow key={`${card.id}-${g.grader}-${g.grade}`} card={card} graded={g} />
                ))}
              </React.Fragment>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
