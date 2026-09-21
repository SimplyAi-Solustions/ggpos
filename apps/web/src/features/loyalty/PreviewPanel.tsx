/**
 * The live points preview: what one sale would earn under the rules exactly
 * as they are being edited, unsaved changes included.
 *
 * It is the first thing in the Rules section because it is the question an
 * admin actually has ("if I turn this on, what does a Saturday sealed sale
 * pay?"), and it runs through the same `evaluateSalePoints` the sale route
 * runs, so the figure on screen is the figure the till will post.
 */
import * as React from "react"
import { evaluateSalePoints, type LoyaltyProgramme, type LoyaltyRule, type LoyaltyTier } from "@gg/shared"

import { Chip, ChipGroup } from "@/components/ui/chip"
import { Field } from "@/components/ui/field"
import { MicroLabel } from "@/components/ui/micro-label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { MoneyInput } from "@/features/sell/money-input"
import { penceToField } from "@/features/sell/money"
import { parseDecimalToMinor } from "@gg/shared"
import {
  PREVIEW_KINDS,
  WEEKDAYS,
  previewContext,
  previewRows,
  previewSentence,
  type PreviewInput,
} from "@/features/loyalty/preview"
import type { GameRecord } from "@/lib/api/types"

export interface PreviewPanelProps {
  input: PreviewInput
  onChange: (patch: Partial<PreviewInput>) => void
  programme: LoyaltyProgramme
  rules: LoyaltyRule[]
  tiers: LoyaltyTier[]
  games: GameRecord[]
}

export function PreviewPanel({
  input,
  onChange,
  programme,
  rules,
  tiers,
  games,
}: PreviewPanelProps) {
  const [amountText, setAmountText] = React.useState(() => penceToField(input.amount))

  const breakdown = evaluateSalePoints(programme, rules, previewContext(input, tiers))
  const rows = previewRows(breakdown, programme, input)
  const sentence = previewSentence(
    input,
    {
      gameName: games.find((game) => game.id === input.game)?.name ?? null,
      tierName: tiers.find((tier) => tier.id === input.tierId)?.name ?? null,
    },
    breakdown.total
  )

  return (
    <div data-testid="points-preview">
      <div className="flex flex-col gap-8 min-[900px]:flex-row min-[900px]:gap-16">
        <div className="flex min-w-0 flex-1 flex-col gap-8">
          <Field label="Sale" htmlFor="preview-amount" layout="stacked">
            <MoneyInput
              id="preview-amount"
              value={amountText}
              onChange={(next) => {
                setAmountText(next)
                const pence = parseDecimalToMinor(next)
                if (pence !== null) onChange({ amount: pence })
              }}
            />
          </Field>

          <Field label="Game" layout="stacked">
            <Select
              value={input.game}
              onValueChange={(next: string | null) => onChange({ game: next })}
            >
              <SelectTrigger aria-label="Game on the preview sale">
                <SelectValue placeholder="Any game">
                  {(value: string) =>
                    games.find((game) => game.id === value)?.name ?? "Any game"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={null}>Any game</SelectItem>
                {games.map((game) => (
                  <SelectItem key={game.id} value={game.id}>
                    {game.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Kind" layout="stacked">
            <ChipGroup
              aria-label="What is being sold"
              value={[input.kind]}
              onValueChange={(next: string[]) => {
                const kind = next[0]
                if (kind) onChange({ kind })
              }}
            >
              {PREVIEW_KINDS.map((kind) => (
                <Chip key={kind} value={kind}>
                  {kind}
                </Chip>
              ))}
            </ChipGroup>
          </Field>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-8">
          <Field label="Day" layout="stacked">
            <Select
              value={String(input.weekday)}
              onValueChange={(next: string | null) =>
                onChange({ weekday: Number(next ?? input.weekday) })
              }
            >
              <SelectTrigger aria-label="Day of the week">
                <SelectValue>
                  {(value: string) => WEEKDAYS[Number(value)] ?? "Saturday"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {WEEKDAYS.map((day, index) => (
                  <SelectItem key={day} value={String(index)}>
                    {day}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Tier" layout="stacked">
            <Select
              value={input.tierId}
              onValueChange={(next: string | null) => onChange({ tierId: next })}
            >
              <SelectTrigger aria-label="The customer's tier">
                <SelectValue placeholder="No tier">
                  {(value: string) =>
                    tiers.find((tier) => tier.id === value)?.name ?? "No tier"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={null}>No tier</SelectItem>
                {tiers.map((tier) => (
                  <SelectItem key={tier.id} value={tier.id}>
                    {tier.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-4">
              <Switch
                checked={input.firstPurchase}
                onCheckedChange={(next: boolean) => onChange({ firstPurchase: next })}
                aria-label="Their first purchase"
              />
              <span className="text-[15px] text-muted-foreground">
                Their first purchase
              </span>
            </div>
            <div className="flex items-center gap-4">
              <Switch
                checked={input.birthdayMonth}
                onCheckedChange={(next: boolean) => onChange({ birthdayMonth: next })}
                aria-label="Their birthday month"
              />
              <span className="text-[15px] text-muted-foreground">
                Their birthday month
              </span>
            </div>
          </div>
        </div>
      </div>

      <p
        data-testid="preview-sentence"
        aria-live="polite"
        className="mt-10 max-w-[56ch] text-base leading-[1.5] text-foreground"
      >
        {sentence}
      </p>

      <ul className="mt-6 max-w-[40rem]">
        {rows.map((row) => (
          <li
            key={row.key}
            className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-hairline-soft py-3 first:border-t"
          >
            <span className="min-w-0">
              <span className="block truncate text-[15px] text-foreground">
                {row.label}
              </span>
              <span className="block truncate text-[13px] text-muted-foreground-2">
                {row.detail}
              </span>
            </span>
            <span className="tnum text-[15px] text-foreground">{row.points}</span>
          </li>
        ))}
        <li className="flex items-baseline justify-between gap-6 py-3">
          <MicroLabel tone="ink">Earns</MicroLabel>
          <span
            data-testid="preview-total"
            className="tnum text-[20px] leading-none font-medium text-foreground"
          >
            {breakdown.total.toLocaleString("en-GB")}
          </span>
        </li>
      </ul>
    </div>
  )
}
