/**
 * Tiers and their perks: the list, and the sheet that edits one.
 *
 * A perk is a typed entry, not free text, because the evaluator, the Sell
 * screen's discount and the wallet on a customer's profile all read the same
 * six shapes. Each one is a switch and its own figure, so a perk that is off
 * is simply absent from the tier rather than stored as a zero.
 */
import * as React from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Field, FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { PERK_LABEL } from "@/features/loyalty/perks"
import {
  PERK_SCOPES,
  emptyTier,
  tierPerks,
  validateTier,
  type TierForm,
} from "@/features/loyalty/mapping"

/** One switch, its figure, and the line that says what it does. */
function PerkRow({
  id,
  label,
  on,
  onToggle,
  value,
  onValue,
  unit,
  error,
  children,
}: {
  id: string
  label: string
  on: boolean
  onToggle: (next: boolean) => void
  value?: string
  onValue?: (next: string) => void
  unit?: string
  error?: string
  children?: React.ReactNode
}) {
  return (
    <div className="border-b border-hairline-soft py-4 first:border-t">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <span className="flex items-center gap-4">
          <Switch checked={on} onCheckedChange={onToggle} aria-label={label} />
          <span className="text-[15px] text-foreground">{label}</span>
        </span>
        {on && onValue ? (
          <span className="w-28">
            <Input
              id={id}
              className="tnum"
              inputMode="decimal"
              autoComplete="off"
              maxLength={5}
              trailingHint={unit}
              aria-label={`${label} value`}
              aria-invalid={Boolean(error) || undefined}
              value={value ?? ""}
              onChange={(event) => onValue(event.target.value)}
            />
          </span>
        ) : null}
      </div>
      {on ? children : null}
      <FieldError>{error}</FieldError>
    </div>
  )
}

function TierFormBody({
  draft,
  others,
  onChange,
  onSave,
  onCancel,
}: {
  draft: TierForm
  others: TierForm[]
  onChange: (patch: Partial<TierForm>) => void
  onSave: () => void
  onCancel: () => void
}) {
  const [showErrors, setShowErrors] = React.useState(false)
  const errors = validateTier(draft, others)
  const shown = showErrors ? errors : {}

  return (
    <>
      <SheetBody>
        <div className="flex flex-col gap-8">
          <Field label="Name" htmlFor="tier-name" layout="stacked" error={shown.name}>
            <Input
              id="tier-name"
              autoComplete="off"
              placeholder="Regular"
              value={draft.name}
              aria-invalid={Boolean(shown.name) || undefined}
              onChange={(event) => onChange({ name: event.target.value })}
            />
          </Field>

          <Field label="Paid plan" layout="stacked">
            <div className="flex items-center gap-4">
              <Switch
                checked={draft.paidPlan}
                onCheckedChange={(next: boolean) => onChange({ paidPlan: next })}
                aria-label="This tier is a paid plan"
              />
              <span className="text-[15px] text-foreground">
                {draft.paidPlan ? "Bought, not earned" : "Earned on points"}
              </span>
            </div>
            <p className="mt-2 max-w-[48ch] text-[13px] leading-[1.45] text-muted-foreground-2">
              A paid plan pins the tier for as long as the membership runs, whatever
              the points say.
            </p>
          </Field>

          {draft.paidPlan ? null : (
            <Field
              label="Threshold"
              htmlFor="tier-threshold"
              layout="stacked"
              error={shown.thresholdPoints}
            >
              <Input
                id="tier-threshold"
                className="tnum"
                inputMode="numeric"
                autoComplete="off"
                maxLength={7}
                trailingHint="points"
                value={draft.thresholdPoints}
                aria-invalid={Boolean(shown.thresholdPoints) || undefined}
                onChange={(event) => onChange({ thresholdPoints: event.target.value })}
              />
              <p className="mt-2 max-w-[48ch] text-[13px] leading-[1.45] text-muted-foreground-2">
                Points earned inside the rolling window, not the balance.
              </p>
            </Field>
          )}

          <Field label="Sort" htmlFor="tier-sort" layout="stacked" error={shown.sort}>
            <Input
              id="tier-sort"
              className="tnum"
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              value={draft.sort}
              aria-invalid={Boolean(shown.sort) || undefined}
              onChange={(event) => onChange({ sort: event.target.value })}
            />
          </Field>

          <div>
            <p className="mb-3 font-mono text-[11px] leading-[1.4] font-bold tracking-[0.16em] text-foreground uppercase">
              Perks
            </p>
            <PerkRow
              id="tier-percent-off"
              label={PERK_LABEL.percent_off}
              on={draft.percentOff}
              onToggle={(next) => onChange({ percentOff: next })}
              value={draft.percentOffValue}
              onValue={(next) => onChange({ percentOffValue: next })}
              unit="%"
              error={shown.percentOffValue ?? shown.percentOffScope}
            >
              <div className="mt-4">
                <ChipGroup
                  aria-label="What the discount applies to"
                  multiple
                  value={draft.percentOffScope}
                  onValueChange={(next: string[]) => onChange({ percentOffScope: next })}
                >
                  {PERK_SCOPES.map((scope) => (
                    <Chip key={scope} value={scope}>
                      {scope}
                    </Chip>
                  ))}
                </ChipGroup>
              </div>
            </PerkRow>

            <PerkRow
              id="tier-multiplier"
              label={PERK_LABEL.points_multiplier}
              on={draft.multiplier}
              onToggle={(next) => onChange({ multiplier: next })}
              value={draft.multiplierValue}
              onValue={(next) => onChange({ multiplierValue: next })}
              unit="times"
              error={shown.multiplierValue}
            />

            <PerkRow
              id="tier-free-entries"
              label={PERK_LABEL.free_event_entries}
              on={draft.freeEntries}
              onToggle={(next) => onChange({ freeEntries: next })}
              value={draft.freeEntriesValue}
              onValue={(next) => onChange({ freeEntriesValue: next })}
              unit="a month"
              error={shown.freeEntriesValue}
            />

            <PerkRow
              id="tier-lounge-hours"
              label={PERK_LABEL.lounge_hours}
              on={draft.loungeHours}
              onToggle={(next) => onChange({ loungeHours: next })}
              value={draft.loungeHoursValue}
              onValue={(next) => onChange({ loungeHoursValue: next })}
              unit="a month"
              error={shown.loungeHoursValue}
            />

            <PerkRow
              id="tier-priority-booking"
              label={PERK_LABEL.priority_release_booking}
              on={draft.priorityBooking}
              onToggle={(next) => onChange({ priorityBooking: next })}
            />

            <PerkRow
              id="tier-member-pricing"
              label={PERK_LABEL.member_event_pricing}
              on={draft.memberEventPricing}
              onToggle={(next) => onChange({ memberEventPricing: next })}
            />
          </div>
        </div>
      </SheetBody>
      <SheetFooter>
        <Button
          type="button"
          trailingArrow
          onClick={() => {
            setShowErrors(true)
            if (Object.keys(errors).length > 0) return
            onSave()
          }}
        >
          Save tier
        </Button>
        <Button variant="text" type="button" onClick={onCancel}>
          Cancel
        </Button>
      </SheetFooter>
    </>
  )
}

export interface TiersSectionProps {
  tiers: TierForm[]
  onSave: (tier: TierForm) => void
}

export function TiersSection({ tiers, onSave }: TiersSectionProps) {
  const [draft, setDraft] = React.useState<TierForm | null>(null)

  return (
    <>
      <ul data-testid="loyalty-tiers">
        {tiers.map((tier) => {
          const perks = tierPerks(tier)
          return (
            <li key={tier.key} className="border-b border-hairline-soft first:border-t">
              <button
                type="button"
                onClick={() => setDraft({ ...tier })}
                className="flex min-h-14 w-full items-center gap-4 py-3 text-left transition-colors duration-150 ease-gg hover:bg-row-hover"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] text-foreground">
                    {tier.name || "Untitled tier"}
                  </span>
                  <span className="block truncate text-[13px] text-muted-foreground-2">
                    {perks.length === 0
                      ? "No perks"
                      : perks.map((perk) => PERK_LABEL[perk.type]).join(", ")}
                  </span>
                </span>
                {tier.paidPlan ? (
                  <Badge variant="outline">Paid plan</Badge>
                ) : (
                  <span className="tnum shrink-0 text-[15px] text-foreground">
                    {(Number(tier.thresholdPoints) || 0).toLocaleString("en-GB")}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>

      <div className="mt-6">
        <Button
          variant="text"
          type="button"
          onClick={() =>
            setDraft(emptyTier(`new-${Date.now()}`, (tiers.length + 1) * 10))
          }
        >
          Add a tier
        </Button>
      </div>

      <Sheet
        open={draft !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setDraft(null)
        }}
      >
        <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle>Tier</SheetTitle>
            <SheetDescription>What it takes to reach it, and what it gives.</SheetDescription>
          </SheetHeader>
          {draft ? (
            <TierFormBody
              draft={draft}
              others={tiers}
              onChange={(patch) =>
                setDraft((current) => (current ? { ...current, ...patch } : current))
              }
              onSave={() => {
                onSave(draft)
                setDraft(null)
              }}
              onCancel={() => setDraft(null)}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  )
}
