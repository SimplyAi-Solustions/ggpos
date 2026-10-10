/**
 * The Card Uploader review queue: the rows that carried a name but no id, so
 * the importer would not guess which card they are.
 *
 * Each one gets a lookup box. Picking a card posts the row number and that
 * card id to `POST /api/vault/imports/:id/link`, and the route does the rest:
 * it runs the same three-path rule the automatic import runs, marks the item
 * listed with the row's own price and SKU, and rewrites the import's errors
 * inside one transaction. Nothing here guesses at a price, a SKU or a title,
 * and nothing here writes an item: a screen that did could only disagree with
 * the file the server already read.
 *
 * Skipping a row dismisses it and lists nothing.
 */
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { formatGBP } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MicroLabel } from "@/components/ui/micro-label"
import { ProductImage } from "@/components/product-image"
import { refusalOrFallback } from "@/lib/api/refusal"
import { lookupCards } from "@/lib/api"
import { linkReviewRow, skipReviewRow } from "@/lib/api/imports"
import { useDebounced } from "@/features/pricing/use-debounced"
import type {
  CardHit,
  CsvImportError,
  LinkReviewResult,
  ReviewLinkPath,
} from "@/lib/api/types"

/** What the row now is, said in the same words the route uses for it. */
const PATH_WORDS: Record<ReviewLinkPath, string> = {
  ebay_sku: "Linked to the item already carrying that SKU.",
  in_stock: "Linked to the copy already in stock.",
  created: "Listed as a new item. It has no cost, so check it.",
  skipped: "Skipped.",
}

function Candidate({
  card,
  onPick,
  pending,
}: {
  card: CardHit
  onPick: () => void
  pending: boolean
}) {
  return (
    <li className="border-b border-hairline-soft">
      <button
        type="button"
        disabled={pending}
        onClick={onPick}
        className="flex min-h-12 w-full items-center gap-4 py-2 text-left transition-colors duration-150 ease-gg hover:bg-row-hover disabled:opacity-50"
      >
        <ProductImage src={card.image} alt="" platform="tcg_card" height={40} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] text-foreground">{card.name}</span>
          <span className="block truncate text-[13px] text-muted-foreground-2">
            {card.setName} &middot; {card.number}
          </span>
        </span>
        <MicroLabel tone="hint">Link</MicroLabel>
      </button>
    </li>
  )
}

function ReviewRow({
  importId,
  entry,
  onResolved,
}: {
  importId: string
  entry: CsvImportError
  onResolved: (result: LinkReviewResult) => void
}) {
  const [query, setQuery] = React.useState(entry.name ?? "")
  const [error, setError] = React.useState<string | null>(null)
  // A queue of twenty rows must not fire twenty adapter lookups on mount, so
  // the search only runs once this row is the one being worked on.
  const [active, setActive] = React.useState(false)
  const needle = useDebounced(query, 250)

  const hits = useQuery({
    queryKey: ["review-lookup", needle],
    queryFn: ({ signal }) => lookupCards("", needle, 5, signal),
    enabled: active && needle.trim().length >= 2,
    staleTime: 60_000,
  })

  const link = useMutation({
    mutationFn: (card: CardHit) =>
      linkReviewRow({ importId, row: entry.row ?? 0, cardId: card.id }),
    onSuccess: onResolved,
    onError: (err) =>
      setError(refusalOrFallback(err, "That did not link. Try again.")),
  })

  const skip = useMutation({
    mutationFn: () => skipReviewRow(importId, entry.row ?? 0),
    onSuccess: onResolved,
    onError: (err) =>
      setError(refusalOrFallback(err, "That row did not go. Try again.")),
  })

  const pending = link.isPending || skip.isPending
  const detail = [
    `Line ${entry.row ?? 0}`,
    entry.set,
    entry.number,
    entry.condition,
    entry.quantity && entry.quantity > 1 ? `${entry.quantity} of them` : "",
    entry.ebay_sku,
  ].filter(Boolean)

  return (
    <li data-testid="review-row" className="border-b border-hairline-soft py-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-[15px] text-foreground">
            {entry.name || "No name on the row"}
          </span>
          <span className="text-[13px] text-muted-foreground-2">
            {detail.join(" · ")}
          </span>
        </span>
        <span className="tnum shrink-0 text-[15px] text-foreground">
          {/* The price the server parsed from the file, and nothing else. A
              row whose price it could not read says so rather than £0.00. */}
          {typeof entry.price === "number"
            ? formatGBP(entry.price)
            : "No price on the row"}
        </span>
      </div>

      <Field
        label="Find the card"
        htmlFor={`review-lookup-${entry.row}`}
        layout="stacked"
        className="mt-5"
      >
        <Input
          id={`review-lookup-${entry.row}`}
          value={query}
          autoComplete="off"
          placeholder="Name, or set and number"
          onFocus={() => setActive(true)}
          onChange={(event) => {
            setActive(true)
            setQuery(event.target.value)
            setError(null)
          }}
        />
      </Field>

      {active && hits.data && hits.data.length > 0 ? (
        <ul className="mt-4">
          {hits.data.map((card) => (
            <Candidate
              key={card.id}
              card={card}
              pending={pending}
              onPick={() => link.mutate(card)}
            />
          ))}
        </ul>
      ) : active && needle.trim().length >= 2 && !hits.isFetching ? (
        <p className="mt-4 text-[13px] text-muted-foreground-2">
          Nothing matches that. Try the set code and the number.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-4 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}

      <div className="mt-5">
        <Button variant="text" onClick={() => skip.mutate()} loading={skip.isPending}>
          Skip this row
        </Button>
      </div>
    </li>
  )
}

export function ReviewQueue({
  importId,
  rows,
  onResolved,
}: {
  importId: string
  rows: CsvImportError[]
  onResolved: (result: LinkReviewResult) => void
}) {
  const queryClient = useQueryClient()
  const [said, setSaid] = React.useState<string | null>(null)

  function resolved(result: LinkReviewResult) {
    setSaid(PATH_WORDS[result.path])
    // A link can list a new item or move one on to eBay, so the stock the
    // rest of the counter is reading is no longer what it was.
    void queryClient.invalidateQueries({ queryKey: ["items"] })
    void queryClient.invalidateQueries({ queryKey: ["item"] })
    void queryClient.invalidateQueries({ queryKey: ["end-listings"] })
    onResolved(result)
  }

  if (rows.length === 0) {
    return (
      <>
        <p className="text-[15px] text-muted-foreground-2">
          Nothing is waiting to be matched.
        </p>
        {said ? (
          <p aria-live="polite" className="mt-3 text-[13px] text-muted-foreground-2">
            {said}
          </p>
        ) : null}
      </>
    )
  }

  return (
    <>
      <p className="mb-6 max-w-[64ch] text-[15px] leading-[1.5] text-muted-foreground">
        {rows.length} {rows.length === 1 ? "row" : "rows"} carried a name but no
        TCGplayer or Cardmarket id, so the import did not guess. Find the card
        and the listing goes on with it.
      </p>
      {said ? (
        <p aria-live="polite" className="mb-6 text-[13px] text-muted-foreground-2">
          {said}
        </p>
      ) : null}
      <ul data-testid="review-queue">
        {rows.map((entry) => (
          <ReviewRow
            key={entry.row}
            importId={importId}
            entry={entry}
            onResolved={resolved}
          />
        ))}
      </ul>
    </>
  )
}
