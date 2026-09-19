import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { SearchIcon } from "lucide-react"
import { cn } from "cn"

import { Input } from "@/components/ui/input"
import { ProductImage } from "@/components/product-image"
import { searchCards, type CardHit } from "@/lib/api"

export interface CardSearchFieldProps {
  id: string
  /** Narrows the catalogue to one game, by its `key`. */
  gameKey?: string
  value: CardHit | null
  onChange: (card: CardHit | null) => void
  invalid?: boolean
  describedBy?: string
  inputRef?: React.RefObject<HTMLInputElement | null>
}

/**
 * One field for "sv151 199", "charizard" or a bare number. The results are a
 * hairline dropdown, not a card: same paper, same rules as the Select popup.
 *
 * Combobox semantics throughout, so a screen reader hears the number of hits
 * and which one is active as the arrow keys move.
 */
export function CardSearchField({
  id,
  gameKey,
  value,
  onChange,
  invalid,
  describedBy,
  inputRef,
}: CardSearchFieldProps) {
  const [query, setQuery] = React.useState("")
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(0)
  const listId = `${id}-listbox`

  const deferred = React.useDeferredValue(query)
  const enabled = deferred.trim().length >= 2 && !value

  const { data: results = [] } = useQuery({
    queryKey: ["cards", deferred, gameKey ?? ""],
    queryFn: () => searchCards(deferred, { gameKey, limit: 8 }),
    enabled,
    staleTime: 30_000,
  })

  const showList = open && enabled && results.length > 0
  const clampedActive = Math.min(active, Math.max(results.length - 1, 0))

  function choose(card: CardHit) {
    onChange(card)
    setQuery(`${card.setCode} ${card.number}`)
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
      const card = results[clampedActive]
      if (card) choose(card)
    } else if (event.key === "Escape") {
      setOpen(false)
    }
  }

  return (
    <div className="relative">
      <Input
        id={id}
        ref={inputRef}
        role="combobox"
        aria-expanded={showList}
        aria-controls={showList ? listId : undefined}
        aria-activedescendant={
          showList ? `${id}-option-${clampedActive}` : undefined
        }
        aria-autocomplete="list"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoComplete="off"
        spellCheck={false}
        leadingIcon={<SearchIcon />}
        placeholder="sv151 199, or a card name"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setActive(0)
          setOpen(true)
          if (value) onChange(null)
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
              aria-selected={index === clampedActive}
              onMouseDown={(event) => {
                event.preventDefault()
                choose(card)
              }}
              onMouseEnter={() => setActive(index)}
              className={cn(
                "flex cursor-default items-center gap-4 border-b border-hairline-soft px-3 py-2 last:border-b-0",
                index === clampedActive && "bg-secondary"
              )}
            >
              <ProductImage
                src={card.image}
                alt=""
                platform="tcg_card"
                height={40}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] text-foreground">
                  {card.name}
                </span>
                <span className="block truncate text-[13px] text-muted-foreground-2">
                  {card.setName} &middot; {card.number}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
