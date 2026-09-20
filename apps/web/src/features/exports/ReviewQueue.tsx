/**
 * The Card Uploader review queue: the rows that carried a name but no id, so
 * the importer would not guess which card they are.
 *
 * Each one gets a lookup box. Linking it puts the card on as listed on eBay
 * with the file's own custom label and price; skipping it takes the row off
 * the queue and changes nothing. Neither invents a cost: a listing with
 * nothing already in stock behind it has no purchase price, and a made-up one
 * would put a false margin on the item for ever.
 */
import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useQuery } from "@tanstack/react-query"
import { formatGBP } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MicroLabel } from "@/components/ui/micro-label"
import { ProductImage } from "@/components/product-image"
import { refusalOrFallback } from "@/lib/api/refusal"
import { linkReviewRow, lookupCards, skipReviewRow } from "@/lib/api"
import { useDebounced } from "@/features/pricing/use-debounced"
import type { CardHit, CsvImportError, CsvImportRecord } from "@/lib/api/types"

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
  onChanged,
}: {
  importId: string
  entry: CsvImportError
  onChanged: (record: CsvImportRecord) => void
}) {
  const [query, setQuery] = React.useState(entry.name ?? "")
  const [error, setError] = React.useState<string | null>(null)
  const needle = useDebounced(query, 250)

  const hits = useQuery({
    queryKey: ["review-lookup", needle],
    queryFn: ({ signal }) => lookupCards("", needle, 5, signal),
    enabled: needle.trim().length >= 2,
    staleTime: 60_000,
  })

  const link = useMutation({
    mutationFn: (card: CardHit) =>
      linkReviewRow({
        importId,
        row: entry.row ?? 0,
        cardId: card.id,
        ebaySku: entry.ebay_sku ?? "",
        price: entry.price ?? 0,
        title: card.name,
      }),
    onSuccess: onChanged,
    onError: (err) =>
      setError(refusalOrFallback(err, "That did not link. Try again.")),
  })

  const skip = useMutation({
    mutationFn: () => skipReviewRow(importId, entry.row ?? 0),
    onSuccess: onChanged,
    onError: (err) =>
      setError(refusalOrFallback(err, "That row did not go. Try again.")),
  })

  const pending = link.isPending || skip.isPending

  return (
    <li data-testid="review-row" className="border-b border-hairline-soft py-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-[15px] text-foreground">{entry.name || "No name on the row"}</span>
          <span className="text-[13px] text-muted-foreground-2">
            Line {entry.row ?? 0}
            {entry.set ? ` · ${entry.set}` : ""}
            {entry.number ? ` · ${entry.number}` : ""}
            {entry.ebay_sku ? ` · ${entry.ebay_sku}` : ""}
          </span>
        </span>
        <span className="tnum shrink-0 text-[15px] text-foreground">
          {formatGBP(entry.price ?? 0)}
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
          onChange={(event) => {
            setQuery(event.target.value)
            setError(null)
          }}
        />
      </Field>

      {hits.data && hits.data.length > 0 ? (
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
      ) : needle.trim().length >= 2 && !hits.isFetching ? (
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
  onChanged,
}: {
  importId: string
  rows: CsvImportError[]
  onChanged: (record: CsvImportRecord) => void
}) {
  const queryClient = useQueryClient()

  function changed(record: CsvImportRecord) {
    void queryClient.invalidateQueries({ queryKey: ["csv-import", importId] })
    onChanged(record)
  }

  if (rows.length === 0) {
    return (
      <p className="text-[15px] text-muted-foreground-2">
        Nothing is waiting to be matched.
      </p>
    )
  }

  return (
    <>
      <p className="mb-6 max-w-[64ch] text-[15px] leading-[1.5] text-muted-foreground">
        {rows.length} {rows.length === 1 ? "row" : "rows"} carried a name but no
        TCGplayer or Cardmarket id, so the import did not guess. Find the card
        and the listing goes on with it.
      </p>
      <ul data-testid="review-queue">
        {rows.map((entry) => (
          <ReviewRow
            key={entry.row}
            importId={importId}
            entry={entry}
            onChanged={changed}
          />
        ))}
      </ul>
    </>
  )
}
