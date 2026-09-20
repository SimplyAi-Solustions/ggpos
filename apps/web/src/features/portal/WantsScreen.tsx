import * as React from "react"
import { createPortal } from "react-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { formatGBP, parseDecimalToMinor } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Field, FieldError } from "@/components/ui/field"
import { MicroLabel } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { SkeletonText } from "@/components/ui/skeleton"
import { StickerCards } from "@/components/ui/sticker"
import { Input } from "@/components/ui/input"
import { addWant, closeWant, listMyWants } from "@/lib/api/wants"
import { refusalOrFallback } from "@/lib/api/refusal"
import { usePortalDock } from "@/features/portal/dock"
import { formatDateTime } from "@/features/portal/format"
import { Note } from "@/features/portal/Note"
import { CardSearch } from "@/features/estimate/CardSearch"
import type { EstimateCardHit } from "@/lib/api/types"

/**
 * The want list: cards somebody is after, and the holds the shop puts on one
 * when it comes in.
 *
 * A matched row is the point of the whole screen, so it says in words how
 * long the hold runs and what the item costs, rather than turning a row a
 * different colour and leaving the customer to work it out.
 */
export function WantsScreen() {
  const dock = usePortalDock()
  const queryClient = useQueryClient()
  const [adding, setAdding] = React.useState(false)
  const [card, setCard] = React.useState<EstimateCardHit | null>(null)
  const [freeText, setFreeText] = React.useState("")
  const [maxPrice, setMaxPrice] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)

  const { data: rows, isPending } = useQuery({
    queryKey: ["portal", "wants"],
    queryFn: listMyWants,
  })

  function reset() {
    setCard(null)
    setFreeText("")
    setMaxPrice("")
    setError(null)
  }

  const add = useMutation({
    mutationFn: () => {
      const pence = maxPrice.trim() ? parseDecimalToMinor(maxPrice.trim()) : null
      if (maxPrice.trim() && pence === null) {
        throw new Error("That is not an amount. Write it like 25.00.")
      }
      return addWant(
        {
          cardId: card?.id,
          freeText: card ? undefined : freeText.trim(),
          maxPrice: pence,
        },
        {
          title: card ? card.name : freeText.trim(),
          subtitle: card ? `${card.set} - ${card.number}` : "Typed in by you",
        }
      )
    },
    onSuccess: async () => {
      setAdding(false)
      reset()
      await queryClient.invalidateQueries({ queryKey: ["portal", "wants"] })
    },
    onError: (cause) =>
      setError(
        refusalOrFallback(cause, "That did not save. Try again in a moment.")
      ),
  })

  const close = useMutation({
    mutationFn: (id: string) => closeWant(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["portal", "wants"] }),
  })

  const canAdd = Boolean(card) || freeText.trim().length > 1

  const primary = (
    <Button type="button" trailingArrow onClick={() => setAdding(true)}>
      Add a card
    </Button>
  )

  return (
    <section className="pt-12 sm:pt-20">
      <PageTitle>Want list</PageTitle>
      <Lede>Tell us what you are after and we will hold it when it lands.</Lede>

      {isPending ? (
        <div className="mt-12">
          <SkeletonText lines={4} />
        </div>
      ) : (rows ?? []).length === 0 ? (
        <div className="mt-14 flex items-start gap-5">
          <StickerCards className="size-14" />
          <p className="max-w-[48ch] text-base leading-[1.5] text-muted-foreground">
            Nothing on your list. Add a card and we will put one aside for 48
            hours the moment it comes in.
          </p>
        </div>
      ) : (
        <ul className="mt-12 flex flex-col">
          {(rows ?? []).map((row) => (
            <li
              key={row.id}
              data-testid="want-row"
              className="flex items-start justify-between gap-5 border-b border-hairline-soft py-5"
            >
              <span className="flex min-w-0 flex-col gap-1.5">
                <span className="text-base leading-[1.35] text-foreground">
                  {row.title}
                </span>
                <Note>{row.subtitle}</Note>
                <Note>
                  {row.maxPrice !== null
                    ? `Up to ${formatGBP(row.maxPrice)}`
                    : "Any price"}
                </Note>
                {row.status === "matched" && row.heldUntil ? (
                  <span className="mt-1 text-[15px] leading-[1.45] text-foreground">
                    {`Held for you until ${formatDateTime(row.heldUntil)}`}
                    {row.heldPrice !== null ? `, ${formatGBP(row.heldPrice)}` : ""}
                  </span>
                ) : null}
              </span>
              <Button
                type="button"
                variant="text"
                className="shrink-0"
                loading={close.isPending && close.variables === row.id}
                onClick={() => close.mutate(row.id)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-14 hidden min-[900px]:block">{primary}</div>

      {dock
        ? createPortal(
            <div className="border-t border-hairline-soft bg-background px-5 py-3 min-[900px]:hidden">
              {primary}
            </div>,
            dock
          )
        : null}

      <Sheet
        open={adding}
        onOpenChange={(next) => {
          setAdding(next)
          if (!next) reset()
        }}
      >
        <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle>Add a card</SheetTitle>
          </SheetHeader>
          <SheetBody>
            <CardSearch
              id="want-card"
              label="Card"
              selected={card}
              onSelect={(hit) => {
                setCard(hit)
                setFreeText("")
              }}
              onClear={() => setCard(null)}
            />

            {!card ? (
              <div className="mt-10">
                <Field
                  layout="stacked"
                  label="Or type it"
                  htmlFor="want-free-text"
                  hint="Optional"
                >
                  <Input
                    id="want-free-text"
                    value={freeText}
                    placeholder="Pokemon Snap, boxed"
                    onChange={(event) => setFreeText(event.target.value)}
                  />
                </Field>
              </div>
            ) : null}

            <div className="mt-10">
              <Field
                layout="stacked"
                label="Most you would pay"
                htmlFor="want-max"
                hint="Optional"
              >
                <Input
                  id="want-max"
                  inputMode="decimal"
                  value={maxPrice}
                  placeholder="25.00"
                  leadingIcon={<MicroLabel aria-hidden="true">GBP</MicroLabel>}
                  onChange={(event) => setMaxPrice(event.target.value)}
                />
              </Field>
            </div>

            {error ? <FieldError className="mt-6">{error}</FieldError> : null}
          </SheetBody>
          <SheetFooter>
            <Button
              type="button"
              trailingArrow
              loading={add.isPending}
              disabled={!canAdd}
              onClick={() => add.mutate()}
            >
              Add to my list
            </Button>
            <Button type="button" variant="text" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </section>
  )
}
