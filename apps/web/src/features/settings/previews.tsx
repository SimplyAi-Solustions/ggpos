/**
 * The two previews on the Settings screen.
 *
 * Both run the shared evaluators (`computeOffer`, `suggestSellPrice`) over
 * the form as it stands, not as it was last saved, so an admin can try a
 * percentage and see the offer the counter would make before committing to
 * it. Same functions, same rounding, same answer as the buy-in wizard:
 * nothing here re-implements the maths.
 */
import * as React from "react"
import {
  computeOffer,
  formatGBP,
  roundToRetailEnding,
  suggestSellPrice,
  type ConditionMultipliers,
  type MarkupBand,
  type OfferSettings,
  type PricingRule,
} from "@gg/shared"

import { Chip, ChipGroup } from "@/components/ui/chip"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MicroLabel } from "@/components/ui/micro-label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { MoneyInput } from "@/features/sell/money-input"
import { bandLabel, poundsToPence } from "@/features/settings/mapping"
import type { GameRecord } from "@/lib/api/types"

const PREVIEW_KINDS = ["single", "graded", "retro", "sealed"] as const

/** "single" is what the rule stores; "Single" is what a sentence needs. */
function kindLabel(kind: string | null): string {
  if (!kind) return "Any kind"
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}
const PREVIEW_CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"] as const

export interface OfferPreviewProps {
  rules: PricingRule[]
  settings: OfferSettings
  multipliers: ConditionMultipliers
  games: GameRecord[]
}

/** A line of the offer, in the secondary money figure. */
function Amount({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <span className="flex flex-col gap-1">
      <MicroLabel>{label}</MicroLabel>
      <span data-testid={testId} className="tnum text-[20px] leading-none font-medium">
        {value}
      </span>
    </span>
  )
}

export function OfferPreview({ rules, settings, multipliers, games }: OfferPreviewProps) {
  const [game, setGame] = React.useState("")
  const [kind, setKind] = React.useState<string>("single")
  const [condition, setCondition] = React.useState<string>("NM")
  const [finish, setFinish] = React.useState("")
  const [market, setMarket] = React.useState("100.00")

  const marketPence = poundsToPence(market)
  // `pricing_rules.game` is a relation, so `selectRule` compares record ids.
  // The games list is here for the label, never for the comparison.
  const offer =
    marketPence === null
      ? null
      : computeOffer(
          marketPence,
          { game, kind, condition, finish: finish.trim() },
          rules,
          settings,
          multipliers
        )

  return (
    <div data-testid="offer-preview">
      <MicroLabel tone="ink">Try a value</MicroLabel>
      <p className="mt-3 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
        The offer the counter would make for one item, worked out from the rules
        on this page before they are saved.
      </p>

      <div className="min-[900px]:grid min-[900px]:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] min-[900px]:gap-16">
      <div className="mt-6 flex flex-col gap-6">
        <Field label="Game" htmlFor="preview-game" layout="stacked">
          <Select value={game || null} onValueChange={(next) => setGame(next ?? "")}>
            <SelectTrigger id="preview-game">
              <SelectValue placeholder="Any game">
                {(value: string) =>
                  games.find((row) => row.id === value)?.name ?? "Any game"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Any game</SelectItem>
              {games.map((row) => (
                <SelectItem key={row.id} value={row.id}>
                  {row.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Kind" layout="stacked">
          <ChipGroup
            aria-label="Kind"
            value={[kind]}
            onValueChange={(next: string[]) => setKind(next[0] ?? kind)}
          >
            {PREVIEW_KINDS.map((value) => (
              <Chip key={value} value={value}>
                {kindLabel(value)}
              </Chip>
            ))}
          </ChipGroup>
        </Field>

        <Field label="Condition" layout="stacked">
          <ChipGroup
            aria-label="Condition"
            value={[condition]}
            onValueChange={(next: string[]) => setCondition(next[0] ?? condition)}
          >
            {PREVIEW_CONDITIONS.map((value) => (
              <Chip key={value} value={value}>
                {value}
              </Chip>
            ))}
          </ChipGroup>
        </Field>

        <Field label="Finish" htmlFor="preview-finish" layout="stacked">
          <Input
            id="preview-finish"
            autoComplete="off"
            placeholder="Any finish"
            value={finish}
            onChange={(event) => setFinish(event.target.value)}
          />
        </Field>

        <Field label="Market value" htmlFor="preview-market" layout="stacked">
          <MoneyInput
            id="preview-market"
            value={market}
            onChange={setMarket}
            invalid={marketPence === null}
          />
        </Field>
      </div>

      <div className="mt-8 border-t border-hairline-soft pt-6 min-[900px]:mt-6 min-[900px]:border-t-0 min-[900px]:border-l min-[900px]:pt-2 min-[900px]:pl-10">
        {offer === null ? (
          <p className="text-[13px] leading-[1.45] text-destructive">
            Enter the market value in pounds and pence, for example 12.50.
          </p>
        ) : (
          <>
            <MicroLabel>Rule</MicroLabel>
            <p data-testid="preview-rule" className="mt-1 text-[15px] text-foreground">
              {offer.bulk
                ? "Bulk rate, at or under the bulk threshold"
                : offer.rule
                  ? `${kindLabel(offer.rule.kind)}, ${bandLabel(offer.rule.bandMin, offer.rule.bandMax)}`
                  : "No rule matches this. Add a band that covers it, or the offer is nothing."}
            </p>
            <p className="mt-1 text-[13px] text-muted-foreground-2">
              Market after condition: {formatGBP(offer.adjustedMarket)}
            </p>
            <div className="mt-6 flex flex-wrap items-start gap-x-12 gap-y-6">
              <Amount label="Cash" value={formatGBP(offer.cash)} testId="preview-cash" />
              <Amount label="Credit" value={formatGBP(offer.credit)} testId="preview-credit" />
            </div>
          </>
        )}
      </div>
      </div>
    </div>
  )
}

/** Three markets a shop actually sees, priced the way the shelf will be. */
const SAMPLE_MARKETS = [300, 1200, 12000]

export function SellPreview({ bands }: { bands: MarkupBand[] }) {
  return (
    <Table data-testid="sell-preview">
      <TableHeader>
        <TableRow>
          <TableHead numeric>Market</TableHead>
          <TableHead numeric>Suggested</TableHead>
          <TableHead numeric>Markup</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {SAMPLE_MARKETS.map((market) => {
          const price = suggestSellPrice(market, bands, roundToRetailEnding)
          return (
            <TableRow key={market}>
              <TableCell numeric>{formatGBP(market)}</TableCell>
              <TableCell numeric>{formatGBP(price)}</TableCell>
              <TableCell numeric>{formatGBP(price - market)}</TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
