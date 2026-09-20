/**
 * Price check: what a card is worth, what we would offer for it in every
 * condition, and how many we are already holding. Nothing is created, nothing
 * is written, nothing is added to a basket.
 *
 * docs/PLAN.md, Screens 2: "Price-check mode shows market value, our offer
 * band and our stock for any card without creating anything."
 */
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { computeOffer, displayCode, formatGBP, type CardCondition } from "@gg/shared"

import { Chip, ChipGroup } from "@/components/ui/chip"
import { MicroLabel } from "@/components/ui/micro-label"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ProductImage } from "@/components/product-image"
import { PriceSources } from "@/features/pricing"
import { finishWords } from "@/features/pricing/sources"
import { offerSettingsFrom, rulesFrom, type CardHit } from "@/lib/api"
import { useVaultConfig } from "@/lib/api/config"
import { stockForCard } from "@/lib/api/lookup"
import { useCardPrices, usePricingSettings } from "@/lib/api/prices"

const CONDITIONS: CardCondition[] = ["NM", "LP", "MP", "HP", "DMG"]

export function PriceCheck({ card }: { card: CardHit }) {
  const pricing = usePricingSettings()
  const { data: config } = useVaultConfig()
  // The price routes match a finish exactly, so a check always names one:
  // the card's own first printing until somebody taps another chip.
  const finishes = card.finishes.length > 0 ? card.finishes : ["normal"]
  const [chosenFinish, setChosenFinish] = React.useState<string | null>(null)
  const finish = chosenFinish && finishes.includes(chosenFinish)
    ? chosenFinish
    : (finishes[0] as string)
  const prices = useCardPrices(card.id, finish, "NM")
  const { data: stock = [], isPending: stockPending } = useQuery({
    queryKey: ["stock-for-card", card.id],
    queryFn: () => stockForCard(card.id),
    staleTime: 30_000,
  })

  const market = prices.data?.chosen?.gbp_market ?? null
  const rules = config ? rulesFrom(config) : []
  const offerSettings = config ? offerSettingsFrom(config) : undefined

  return (
    <div data-testid="price-check">
      <div className="flex items-start gap-5">
        <ProductImage
          src={card.image}
          alt=""
          platform="tcg_card"
          height={96}
          className="shrink-0"
        />
        <div className="min-w-0 flex-1">
          <p data-testid="price-check-name" className="text-[20px] leading-[1.3] text-foreground">
            {card.name}
          </p>
          <p className="mt-1 text-[13px] leading-[1.45] text-muted-foreground-2">
            {[card.setName, card.number, card.rarity].filter(Boolean).join(" · ")}
          </p>
          {market !== null ? (
            <p className="mt-3 flex items-baseline gap-3">
              <MicroLabel>Market</MicroLabel>
              <span
                data-testid="price-check-market"
                className="tnum font-display text-[28px] leading-none tracking-[0.01em] text-foreground"
              >
                {formatGBP(market)}
              </span>
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-16">
        <MicroLabel tone="ink" className="mb-5">
          Sources
        </MicroLabel>
        {finishes.length > 1 ? (
          <ChipGroup
            aria-label="Finish"
            className="mb-6"
            value={[finish]}
            onValueChange={(next) => {
              if (next[0]) setChosenFinish(next[0])
            }}
          >
            {finishes.map((option) => (
              <Chip key={option} value={option}>
                {finishWords(option)}
              </Chip>
            ))}
          </ChipGroup>
        ) : null}
        <PriceSources
          subject={{
            kind: "card",
            id: card.id,
            finish,
            condition: "NM",
            gameKey: card.gameKey,
            title: card.name,
          }}
        />
      </div>

      <div className="mt-16">
        <MicroLabel tone="ink" className="mb-5">
          What we would offer
        </MicroLabel>
        {market === null || !offerSettings ? (
          <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground-2">
            No market value yet, so there is no offer to quote. Refresh the
            sources or add a UK comp.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Condition</TableHead>
                <TableHead numeric>Market</TableHead>
                <TableHead numeric>Cash</TableHead>
                <TableHead numeric>Credit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {CONDITIONS.map((condition) => {
                const offer = computeOffer(
                  market,
                  {
                    game: card.gameId,
                    kind: "single",
                    condition,
                    finish,
                    rarity: card.rarity ?? null,
                  },
                  rules,
                  offerSettings,
                  pricing.conditionMultipliers
                )
                return (
                  <TableRow key={condition} data-testid={`offer-${condition}`}>
                    <TableCell>{condition}</TableCell>
                    <TableCell numeric>{formatGBP(offer.adjustedMarket)}</TableCell>
                    <TableCell numeric>{formatGBP(offer.cash)}</TableCell>
                    <TableCell numeric>{formatGBP(offer.credit)}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>

      <div className="mt-16">
        <MicroLabel tone="ink" className="mb-5">
          In stock
        </MicroLabel>
        {stockPending ? (
          <Skeleton className="h-4 w-48" />
        ) : stock.length === 0 ? (
          <p className="text-[15px] leading-[1.5] text-muted-foreground-2">
            None on the shelf.
          </p>
        ) : (
          <ul data-testid="price-check-stock" className="border-t border-hairline-soft">
            {stock.map((item) => (
              <li
                key={item.id}
                className="flex min-h-12 flex-wrap items-baseline gap-x-6 gap-y-1 border-b border-hairline-soft py-3"
              >
                <span className="tnum shrink-0 font-mono text-[13px] text-foreground">
                  {displayCode(item.sku)}
                </span>
                <span className="min-w-0 flex-1 text-[15px] text-muted-foreground">
                  {[item.detail, item.locationName].filter(Boolean).join(" · ")}
                </span>
                <span className="tnum shrink-0 text-[15px] text-foreground">
                  {formatGBP(item.price)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
