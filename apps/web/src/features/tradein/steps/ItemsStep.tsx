import type {
  ConditionMultipliers,
  OfferSettings,
  PricingRule,
} from "@gg/shared/pricing"
import { formatGBP } from "@gg/shared"

import { SectionHeading } from "@/components/ui/micro-label"
import { TradeLineEntry, TradeLineList } from "@/features/tradein/TradeLines"
import type { TradeLine, Totals } from "@/features/tradein/machine"

export interface ItemsStepProps {
  lines: TradeLine[]
  rules: PricingRule[]
  settings: OfferSettings
  /** The shop's own condition multipliers, from settings. */
  multipliers: ConditionMultipliers
  sums: Totals
  /** True when the shop has no active offer bands at all. */
  rulesMissing: boolean
  onAdd: (line: TradeLine) => void
  onUpdate: (key: string, patch: Partial<TradeLine>) => void
  onRemove: (key: string) => void
  saveError: string | null
}

/**
 * The lines.
 *
 * A card or a retro title prices itself from the price routes, and the line
 * says which source and how old it is; anything without a catalogue row
 * behind it (a sealed box, a lot, a title nobody recognised) takes a figure
 * by hand and says so. The cash and credit offers beside it come from the
 * shared evaluator with the shop's own bands either way, and an override
 * still needs a reason before it will save. The entry and the lines are
 * `TradeLines.tsx`'s parts, which the till's Trade-in panel uses too.
 */
export function ItemsStep({
  lines,
  rules,
  settings,
  multipliers,
  sums,
  rulesMissing,
  onAdd,
  onUpdate,
  onRemove,
  saveError,
}: ItemsStepProps) {
  return (
    <div>
      <SectionHeading className="mt-0">What they are selling</SectionHeading>

      <TradeLineEntry onAdd={onAdd} />

      {rulesMissing ? (
        <p className="mt-8 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground">
          No offer bands are set up yet, so nothing prices itself. Enter each
          offer with Override, or add the bands in Settings.
        </p>
      ) : null}

      {/* ---- The lines ------------------------------------------------- */}
      <TradeLineList
        lines={lines}
        rules={rules}
        settings={settings}
        multipliers={multipliers}
        onUpdate={onUpdate}
        onRemove={onRemove}
      />

      {lines.length === 0 ? (
        <p className="mt-12 max-w-[56ch] text-base leading-[1.5] text-muted-foreground">
          Nothing on the counter yet. Search a card, or add a retro, sealed or
          bulk line.
        </p>
      ) : null}

      {saveError ? (
        <p role="alert" className="mt-8 text-[13px] text-destructive">
          {saveError}
        </p>
      ) : null}

      {/* ---- Totals ------------------------------------------------------
          Only once something is on the counter: three £0.00 figures over an
          empty step are noise, and the sticky bar has nothing to summarise
          until there is a line. */}
      {lines.length > 0 ? (
        <div className="sticky bottom-[var(--gg-dock-h,0px)] z-10 mt-10 border-t border-hairline bg-background py-4">
          <dl className="flex flex-wrap items-baseline gap-x-10 gap-y-3">
            <div className="flex items-baseline gap-3">
              <dt className="font-mono text-[11px] leading-[1.4] font-bold tracking-[0.16em] text-muted-foreground uppercase">
                Market
              </dt>
              <dd className="tnum text-[15px] text-foreground">
                {formatGBP(sums.market)}
              </dd>
            </div>
            <div className="flex items-baseline gap-3">
              <dt className="font-mono text-[11px] leading-[1.4] font-bold tracking-[0.16em] text-muted-foreground uppercase">
                Cash offer
              </dt>
              <dd
                data-testid="total-cash"
                className="tnum text-[15px] text-foreground"
              >
                {formatGBP(sums.cash)}
              </dd>
            </div>
            <div className="flex items-baseline gap-3">
              <dt className="font-mono text-[11px] leading-[1.4] font-bold tracking-[0.16em] text-muted-foreground uppercase">
                Credit offer
              </dt>
              <dd
                data-testid="total-credit"
                className="tnum text-[15px] text-foreground"
              >
                {formatGBP(sums.credit)}
              </dd>
            </div>
          </dl>
        </div>
      ) : null}
    </div>
  )
}
