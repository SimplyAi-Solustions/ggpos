import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { SearchIcon } from "lucide-react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ProductImage } from "@/components/product-image"
import { searchEstimateCards } from "@/lib/api/estimate"
import { useDebounced } from "@/features/pricing/use-debounced"
import type { EstimateCardHit } from "@/lib/api/types"

export interface CardSearchProps {
  id: string
  label: string
  selected: EstimateCardHit | null
  onSelect: (card: EstimateCardHit) => void
  onClear: () => void
}

/**
 * The public card search, shared by the estimate page and the want list.
 *
 * It reads the catalogue through `GET /api/vault/estimate/search`, which is
 * unauthenticated, rate limited and never calls an adapter: a stranger
 * looking up a price cannot make the shop spend money at Cardmarket.
 *
 * Combobox semantics, so a screen reader hears how many cards matched and
 * which one the arrow keys are on.
 */
export function CardSearch({
  id,
  label,
  selected,
  onSelect,
  onClear,
}: CardSearchProps) {
  const [query, setQuery] = React.useState("")
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(0)
  const listId = `${id}-listbox`

  const debounced = useDebounced(query)
  const settled = debounced === query
  const enabled = debounced.trim().length >= 2 && !selected

  const search = useQuery({
    queryKey: ["estimate", "search", debounced],
    queryFn: () => searchEstimateCards(debounced),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  })

  const results = search.data ?? []
  const showList = open && enabled && results.length > 0
  const clamped = Math.min(active, Math.max(results.length - 1, 0))
  const empty = settled && enabled && !search.isFetching && results.length === 0

  function choose(card: EstimateCardHit) {
    onSelect(card)
    setQuery(`${card.name} ${card.number}`)
    setOpen(false)
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!showList) {
      if (event.key === "ArrowDown") setOpen(true)
      return
    }
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setActive((index) => (index + 1) % results.length)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setActive((index) => (index - 1 + results.length) % results.length)
    } else if (event.key === "Enter") {
      event.preventDefault()
      const card = results[clamped]
      if (card) choose(card)
    } else if (event.key === "Escape") {
      setOpen(false)
    }
  }

  return (
    <div>
      <Field
        layout="stacked"
        label={label}
        htmlFor={id}
        hint={selected ? undefined : "Name, or set and number"}
      >
        <div className="relative">
          <Input
            id={id}
            role="combobox"
            aria-expanded={showList}
            aria-controls={showList ? listId : undefined}
            aria-activedescendant={showList ? `${id}-option-${clamped}` : undefined}
            aria-autocomplete="list"
            aria-describedby={`${id}-help`}
            autoComplete="off"
            spellCheck={false}
            leadingIcon={<SearchIcon />}
            placeholder="Charizard, or sv151 199"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
              setOpen(true)
              if (selected) onClear()
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => {
              // A click on a row fires mousedown first, which chooses it.
              window.setTimeout(() => setOpen(false), 0)
            }}
            onKeyDown={handleKeyDown}
          />

          <span aria-live="polite" className="sr-only">
            {showList
              ? `${results.length} ${results.length === 1 ? "card" : "cards"} found`
              : ""}
          </span>

          {showList ? (
            <ul
              id={listId}
              role="listbox"
              aria-label="Matching cards"
              className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-[var(--radius)] border border-hairline bg-popover shadow-panel"
            >
              {results.map((card, index) => (
                <li
                  key={card.id}
                  id={`${id}-option-${index}`}
                  role="option"
                  aria-selected={index === clamped}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    choose(card)
                  }}
                  onMouseEnter={() => setActive(index)}
                  className={cn(
                    "flex cursor-default items-center gap-4 border-b border-hairline-soft px-3 py-2 last:border-b-0",
                    index === clamped && "bg-secondary"
                  )}
                >
                  <ProductImage src={card.image} alt="" platform="tcg_card" height={40} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] text-foreground">
                      {card.name}
                    </span>
                    <span className="block truncate text-[13px] text-muted-foreground-2">
                      {card.set} &middot; {card.number}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Field>

      <p
        id={`${id}-help`}
        className="mt-2 text-[13px] leading-[1.45] text-muted-foreground-2"
      >
        {empty
          ? "Nothing in the catalogue matches that. Check the spelling, or ask at the counter."
          : "Type a card name, or a set code and number like sv151 199."}
      </p>

      {selected ? (
        <div className="mt-6 flex items-center gap-4">
          <ProductImage src={selected.image} alt="" platform="tcg_card" height={56} />
          <div className="min-w-0 flex-1">
            <span className="block truncate text-base text-foreground">
              {selected.name}
            </span>
            <span className="block truncate text-[13px] text-muted-foreground-2">
              {selected.set} &middot; {selected.number}
            </span>
          </div>
          <Button
            type="button"
            variant="text"
            onClick={() => {
              onClear()
              setQuery("")
            }}
          >
            Change
          </Button>
        </div>
      ) : null}
    </div>
  )
}
