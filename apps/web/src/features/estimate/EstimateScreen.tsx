import * as React from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { formatGBP } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { FieldError } from "@/components/ui/field"
import { MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { SkeletonText } from "@/components/ui/skeleton"
import { StickerCards } from "@/components/ui/sticker"
import { getEstimate } from "@/lib/api/estimate"
import { refusalOrFallback } from "@/lib/api/refusal"
import { CardSearch } from "@/features/estimate/CardSearch"
import {
  bandIsEmpty,
  CONDITIONS,
  finishLabel,
  formatBand,
  type EstimateCondition,
} from "@/features/estimate/bands"
import { formatDate } from "@/features/portal/format"
import { Note } from "@/features/portal/Note"
import type { EstimateCardHit } from "@/lib/api/types"

export interface EstimateScreenProps {
  /** Public visitors get the sign-up call to action instead of the nav. */
  signedIn: boolean
}

/**
 * What we would pay for a card, before anybody travels.
 *
 * The same screen signed in and signed out: the numbers are public, they are
 * a band rather than a figure, and they carry "Subject to inspection in the
 * shop." because a photo is not an inspection. Signed out it ends with the
 * one thing it is for, which is getting somebody a card.
 */
export function EstimateScreen({ signedIn }: EstimateScreenProps) {
  const [card, setCard] = React.useState<EstimateCardHit | null>(null)
  const [condition, setCondition] = React.useState<EstimateCondition>("NM")
  // The chosen finish is held with the card it was chosen for, so picking a
  // new card falls back to that card's first finish without an effect
  // reaching in to reset it.
  const [chosen, setChosen] = React.useState<{ cardId: string; finish: string } | null>(
    null
  )

  const finishes = card?.finishes ?? []
  const finish =
    card && chosen?.cardId === card.id ? chosen.finish : (finishes[0] ?? "")

  const estimate = useQuery({
    queryKey: ["estimate", card?.id ?? "", condition, finish],
    queryFn: () => getEstimate(card!.id, condition, finish),
    enabled: Boolean(card),
    staleTime: 5 * 60_000,
    retry: false,
  })

  const result = estimate.data
  const nothing = result && result.market === null

  return (
    <section className="pt-12 sm:pt-20">
      <PageTitle>What is it worth</PageTitle>
      <Lede>Pick a card and we will show you what we would pay for it.</Lede>

      <div className="mt-12">
        <CardSearch
          id="estimate-card"
          label="Card"
          selected={card}
          onSelect={setCard}
          onClear={() => setCard(null)}
        />
      </div>

      {card ? (
        <>
          <SectionHeading className="mt-14">Condition</SectionHeading>
          <ChipGroup
            aria-label="Condition"
            value={[condition]}
            onValueChange={(next) => {
              if (next[0]) setCondition(next[0] as EstimateCondition)
            }}
          >
            {CONDITIONS.map((entry) => (
              <Chip key={entry.value} value={entry.value}>
                {entry.label}
              </Chip>
            ))}
          </ChipGroup>

          {finishes.length > 1 ? (
            <>
              <MicroLabel className="mt-10 mb-3">Finish</MicroLabel>
              <ChipGroup
                aria-label="Finish"
                value={finish ? [finish] : []}
                onValueChange={(next) =>
                  card ? setChosen({ cardId: card.id, finish: next[0] ?? "" }) : null
                }
              >
                {finishes.map((entry) => (
                  <Chip key={entry} value={entry}>
                    {finishLabel(entry)}
                  </Chip>
                ))}
              </ChipGroup>
            </>
          ) : null}

          <SectionHeading className="mt-14">Our offer</SectionHeading>
          {estimate.isPending ? (
            <SkeletonText lines={3} />
          ) : estimate.isError ? (
            <FieldError>
              {refusalOrFallback(
                estimate.error,
                "We could not price that just now. Try again in a minute."
              )}
            </FieldError>
          ) : nothing ? (
            <p className="max-w-[56ch] text-base leading-[1.5] text-muted-foreground">
              We have no recent price for that card. Bring it in and we will
              value it at the counter.
            </p>
          ) : result ? (
            <>
              <div className="grid grid-cols-1 gap-x-8 gap-y-10 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <MicroLabel>Cash</MicroLabel>
                  <span
                    data-testid="estimate-cash"
                    className="tnum font-display text-[28px] leading-none tracking-[0.01em] text-foreground"
                  >
                    {bandIsEmpty(result.cash) ? "No offer" : formatBand(result.cash)}
                  </span>
                </div>
                <div className="flex flex-col gap-2">
                  <MicroLabel>Store credit</MicroLabel>
                  <span
                    data-testid="estimate-credit"
                    className="tnum text-[20px] leading-none font-medium text-foreground"
                  >
                    {bandIsEmpty(result.credit)
                      ? "No offer"
                      : formatBand(result.credit)}
                  </span>
                </div>
              </div>

              <p className="mt-10 max-w-[56ch] text-base leading-[1.5] text-muted-foreground">
                {result.note}
              </p>
              {result.market !== null ? (
                <Note className="mt-3">
                  {`Market ${formatGBP(result.market)}, ${formatDate(result.as_of)}`}
                </Note>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}

      {signedIn ? (
        <div className="mt-16 flex flex-col items-start gap-8">
          <Button render={<Link to="/account/quotes/new" />} trailingArrow>
            Send photos for a quote
          </Button>
          <Button variant="text" render={<Link to="/account/wants" />}>
            Add it to my want list
          </Button>
        </div>
      ) : (
        <div className="mt-16 flex items-start gap-5">
          <StickerCards className="size-14 shrink-0" />
          <div className="flex flex-col items-start gap-5">
            <p className="max-w-[48ch] text-base leading-[1.5] text-muted-foreground">
              Join GG Guild at the counter and My Vault gives you a quote from
              your phone, a want list with holds, and points on everything you
              buy.
            </p>
            <Button render={<Link to="/account" />} trailingArrow>
              Sign in to My Vault
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
