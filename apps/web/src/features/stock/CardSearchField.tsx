import * as React from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { SearchIcon } from "lucide-react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MicroLabel } from "@/components/ui/micro-label"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ProductImage } from "@/components/product-image"
import { parseCardQuery, type CardHit } from "@/lib/api"
import { LOOKUP_STALE_MS } from "@/lib/api/prices"
import {
  createManualCard,
  getCard,
  isLookupGame,
  LOOKUP_GAMES,
  searchCards,
} from "@/lib/api/lookup"
import { refusalMessage, refusalOrFallback } from "@/lib/api/refusal"
import { useDebounced } from "@/features/pricing/use-debounced"

/** When the lookup comes back with nothing and no words of its own. */
const FALLBACK_MESSAGE =
  "Nothing in the catalogue matches that. Check the spelling, or add it manually."

export interface CardSearchFieldProps {
  id: string
  /** Narrows the lookup to one game, by its `key`. */
  gameKey?: string
  /** Shown above the field so the lookup has a game to ask. */
  onGameChange?: (gameKey: string) => void
  value: CardHit | null
  onChange: (card: CardHit | null) => void
  invalid?: boolean
  describedBy?: string
  inputRef?: React.RefObject<HTMLInputElement | null>
}

/**
 * One field for "sv151 199", "charizard" or a bare number, answered by the
 * lookup route rather than by what the shop already holds: the adapter finds
 * a card nobody here has ever handled and writes it through to `cards`.
 *
 * The chips come first because every lookup route takes a game. Without one
 * the field still works, asking all five, which is five times the work for
 * the server and worth avoiding at a busy counter.
 *
 * Combobox semantics throughout, so a screen reader hears the number of hits
 * and which one is active as the arrow keys move.
 */
export function CardSearchField({
  id,
  gameKey,
  onGameChange,
  value,
  onChange,
  invalid,
  describedBy,
  inputRef,
}: CardSearchFieldProps) {
  const [query, setQuery] = React.useState("")
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(0)
  const [manualOpen, setManualOpen] = React.useState(false)
  const listId = `${id}-listbox`

  const debounced = useDebounced(query)
  const settled = debounced === query
  const enabled = debounced.trim().length >= 2 && !value
  const game = isLookupGame(gameKey) ? gameKey : ""
  const parsed = React.useMemo(() => parseCardQuery(debounced), [debounced])
  // A set and a number together is an exact lookup, which is the one call
  // that can say "not in this set" rather than just coming back empty.
  const exact = Boolean(game && parsed.setCode && parsed.number)

  const search = useQuery({
    queryKey: ["lookup", "cards", game, debounced],
    // The signal is TanStack's: a keystroke that overtakes this one aborts
    // it, and the fan-out over five games passes it down to each request.
    queryFn: ({ signal }) => searchCards(game, debounced, 8, signal),
    enabled: enabled && !exact,
    staleTime: LOOKUP_STALE_MS,
    // A refusal is an answer: "One Piece search needs a card code, for
    // example OP01-001." should land under the field, not be retried three
    // times first.
    retry: false,
  })

  const one = useQuery({
    queryKey: ["lookup", "card", game, parsed.setCode ?? "", parsed.number ?? ""],
    queryFn: ({ signal }) =>
      getCard(game as "pokemon", parsed.setCode!, parsed.number!, signal),
    enabled: enabled && exact,
    staleTime: LOOKUP_STALE_MS,
    retry: false,
  })

  const results: CardHit[] = exact
    ? one.data
      ? [one.data]
      : []
    : (search.data ?? [])
  const pending = exact ? one.isFetching : search.isFetching

  // The server's own sentence, shown as it is: "Card not found in Scarlet &
  // Violet 151. Check the number or add it manually." for a number that is
  // not in the set, and "One Piece search needs a card code, for example
  // OP01-001." for a game whose adapter cannot search by name.
  const failure = exact ? one.error : search.error
  const refused =
    (exact ? one.isError : search.isError) && failure && settled
      ? refusalOrFallback(failure, FALLBACK_MESSAGE)
      : null
  // Nothing is said about a query that has been typed past: "Card not found
  // in Scarlet & Violet 151" for "sv151 19" is wrong by the time it is read.
  const empty = settled && enabled && !pending && !refused && results.length === 0

  const showList = open && enabled && results.length > 0
  const clampedActive = Math.min(active, Math.max(results.length - 1, 0))

  const manual = useMutation({
    mutationFn: createManualCard,
    onSuccess: (card) => {
      setManualOpen(false)
      choose(card)
    },
  })

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
    <div>
      {onGameChange ? (
        <ChipGroup
          aria-label="Game"
          className="mb-3"
          value={game ? [game] : []}
          onValueChange={(next) => onGameChange(next[0] ?? "")}
        >
          {LOOKUP_GAMES.map((entry) => (
            <Chip key={entry.key} value={entry.key}>
              {entry.label}
            </Chip>
          ))}
        </ChipGroup>
      ) : null}

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

      {refused || empty ? (
        <div
          data-testid="lookup-empty"
          className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-2"
        >
          <p className="max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground">
            {refused ??
              (game
                ? FALLBACK_MESSAGE
                : "Nothing matches that yet. Pick a game to search it properly, or add it manually.")}
          </p>
          <Button variant="text" type="button" onClick={() => setManualOpen(true)}>
            Add it manually
          </Button>
        </div>
      ) : null}

      <ManualCardSheet
        open={manualOpen}
        onOpenChange={setManualOpen}
        gameKey={game}
        initial={{
          name: parsed.text ?? "",
          setCode: parsed.setCode ?? "",
          number: parsed.number ?? "",
        }}
        pending={manual.isPending}
        error={
          manual.isError
            ? (refusalMessage(manual.error) ??
              "That card did not save. Check the details and try again.")
            : null
        }
        onSave={(values) => manual.mutate(values)}
      />
    </div>
  )
}

interface ManualCardValues {
  gameKey: string
  name: string
  setCode: string
  number: string
}

/**
 * A card the catalogue has never heard of, written straight into `cards` with
 * `source: "manual"` so it can be sold, labelled and matched to a real
 * printing later (docs/PLAN.md, "Card not found").
 */
function ManualCardSheet({
  open,
  onOpenChange,
  gameKey,
  initial,
  pending,
  error,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  gameKey: string
  initial: { name: string; setCode: string; number: string }
  pending: boolean
  error: string | null
  onSave: (values: ManualCardValues) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom">
        {open ? (
          <ManualCardBody
            gameKey={gameKey}
            initial={initial}
            pending={pending}
            error={error}
            onSave={onSave}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function ManualCardBody({
  gameKey,
  initial,
  pending,
  error,
  onSave,
  onClose,
}: {
  gameKey: string
  initial: { name: string; setCode: string; number: string }
  pending: boolean
  error: string | null
  onSave: (values: ManualCardValues) => void
  onClose: () => void
}) {
  const [game, setGame] = React.useState(gameKey)
  const [name, setName] = React.useState(initial.name)
  const [setCode, setSetCode] = React.useState(initial.setCode)
  const [number, setNumber] = React.useState(initial.number)
  const [issue, setIssue] = React.useState<string | null>(null)

  return (
    <>
      <SheetHeader>
        <SheetTitle>Add it manually</SheetTitle>
        <SheetDescription>
          It goes in the catalogue as a manual card, ready to match to a real
          printing later.
        </SheetDescription>
      </SheetHeader>
      <SheetBody>
        <div className="flex flex-col gap-8">
          <div>
            <MicroLabel className="mb-3">Game</MicroLabel>
            <ChipGroup
              aria-label="Game"
              value={game ? [game] : []}
              onValueChange={(next) => {
                setGame(next[0] ?? "")
                setIssue(null)
              }}
            >
              {LOOKUP_GAMES.map((entry) => (
                <Chip key={entry.key} value={entry.key}>
                  {entry.label}
                </Chip>
              ))}
            </ChipGroup>
          </div>
          <Field label="Card name" htmlFor="manual-name" layout="stacked">
            <Input
              id="manual-name"
              autoFocus
              autoComplete="off"
              placeholder="Charizard ex"
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setIssue(null)
              }}
            />
          </Field>
          <Field label="Set code" htmlFor="manual-set" layout="stacked">
            <Input
              id="manual-set"
              autoComplete="off"
              spellCheck={false}
              placeholder="sv151"
              value={setCode}
              onChange={(event) => {
                setSetCode(event.target.value)
                setIssue(null)
              }}
            />
          </Field>
          <Field label="Number" htmlFor="manual-number" layout="stacked">
            <Input
              id="manual-number"
              autoComplete="off"
              className="tnum"
              placeholder="199/165"
              value={number}
              onChange={(event) => {
                setNumber(event.target.value)
                setIssue(null)
              }}
            />
          </Field>
        </div>
        {issue || error ? (
          <p role="alert" className="mt-8 text-[13px] text-destructive">
            {issue ?? error}
          </p>
        ) : null}
      </SheetBody>
      <SheetFooter>
        <Button
          type="button"
          trailingArrow
          loading={pending}
          onClick={() => {
            if (!game) {
              setIssue("Pick the game it belongs to.")
              return
            }
            if (!name.trim()) {
              setIssue("Give the card its name, so it can be found on the shelf.")
              return
            }
            if (!setCode.trim() || !number.trim()) {
              setIssue("Give the set code and the number, even a rough one.")
              return
            }
            onSave({
              gameKey: game,
              name: name.trim(),
              setCode: setCode.trim(),
              number: number.trim(),
            })
          }}
        >
          Save card
        </Button>
        <Button variant="text" type="button" onClick={onClose}>
          Cancel
        </Button>
      </SheetFooter>
    </>
  )
}
