/**
 * The rules list and its sheet editor.
 *
 * A rule is edited in the sheet, kept in the page's own state and written
 * with the screen's one block button, which is what lets the preview above
 * the list answer for changes that have not been saved yet.
 */
import * as React from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Field, FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Hint } from "@/components/ui/micro-label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { MoneyInput } from "@/features/sell/money-input"
import { PREVIEW_KINDS, WEEKDAYS } from "@/features/loyalty/preview"
import {
  RULE_TYPES,
  RULE_TYPE_LABEL,
  isMultiplierType,
  ruleSummary,
  validateRule,
  type RuleForm,
  type RuleType,
} from "@/features/loyalty/mapping"
import type { GameRecord } from "@/lib/api/types"

/** Sunday first, but the shop's week reads better starting on Monday. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

function RuleFormBody({
  draft,
  games,
  onChange,
  onSave,
  onCancel,
}: {
  draft: RuleForm
  games: GameRecord[]
  onChange: (patch: Partial<RuleForm>) => void
  onSave: () => void
  onCancel: () => void
}) {
  const [showErrors, setShowErrors] = React.useState(false)
  const errors = validateRule(draft)
  const shown = showErrors ? errors : {}
  const multiplies = isMultiplierType(draft.type)

  return (
    <>
      <SheetBody>
        <div className="flex flex-col gap-8">
          <Field label="Name" htmlFor="rule-name" layout="stacked" error={shown.name}>
            <Input
              id="rule-name"
              autoComplete="off"
              placeholder="Saturday double points"
              value={draft.name}
              aria-invalid={Boolean(shown.name) || undefined}
              onChange={(event) => onChange({ name: event.target.value })}
            />
          </Field>

          <Field label="Type" layout="stacked">
            <Select
              value={draft.type}
              onValueChange={(next: string | null) =>
                onChange({ type: (next as RuleType) ?? draft.type })
              }
            >
              <SelectTrigger aria-label="What kind of rule this is">
                <SelectValue>
                  {(value: string) => RULE_TYPE_LABEL[value as RuleType] ?? value}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {RULE_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {RULE_TYPE_LABEL[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field
            label={multiplies ? "Multiplier" : "Points"}
            htmlFor="rule-value"
            layout="stacked"
            error={shown.value}
          >
            <Input
              id="rule-value"
              className="tnum"
              inputMode="decimal"
              autoComplete="off"
              maxLength={6}
              trailingHint={multiplies ? "times" : "points"}
              value={draft.value}
              aria-invalid={Boolean(shown.value) || undefined}
              onChange={(event) => onChange({ value: event.target.value })}
            />
            <p className="mt-2 max-w-[48ch] text-[13px] leading-[1.45] text-muted-foreground-2">
              {multiplies
                ? "Multipliers stack on the lines they match, then the tier's own multiplier is applied."
                : "A flat bonus added once to a sale that matches."}
            </p>
          </Field>

          <Field label="Games" layout="stacked">
            <ChipGroup
              aria-label="Games this rule applies to"
              multiple
              value={draft.games}
              onValueChange={(next: string[]) => onChange({ games: next })}
            >
              {games.map((game) => (
                <Chip key={game.id} value={game.id}>
                  {game.name}
                </Chip>
              ))}
            </ChipGroup>
            <Hint className="mt-2 block">
              {draft.games.length === 0 ? "Every game" : "Only these"}
            </Hint>
          </Field>

          <Field label="Kinds" layout="stacked">
            <ChipGroup
              aria-label="What this rule applies to"
              multiple
              value={draft.kinds}
              onValueChange={(next: string[]) => onChange({ kinds: next })}
            >
              {PREVIEW_KINDS.map((kind) => (
                <Chip key={kind} value={kind}>
                  {kind}
                </Chip>
              ))}
            </ChipGroup>
            <Hint className="mt-2 block">
              {draft.kinds.length === 0 ? "Every kind" : "Only these"}
            </Hint>
          </Field>

          <Field label="Days" layout="stacked">
            <ChipGroup
              aria-label="Days this rule applies on"
              multiple
              value={draft.weekdays.map(String)}
              onValueChange={(next: string[]) =>
                onChange({ weekdays: next.map(Number) })
              }
            >
              {WEEKDAY_ORDER.map((day) => (
                <Chip key={day} value={String(day)}>
                  {WEEKDAYS[day].slice(0, 3)}
                </Chip>
              ))}
            </ChipGroup>
            <Hint className="mt-2 block">
              {draft.weekdays.length === 0 ? "Every day" : "Only these days"}
            </Hint>
          </Field>

          <Field
            label="Minimum spend"
            htmlFor="rule-min-spend"
            layout="stacked"
            error={shown.minSpend}
          >
            <MoneyInput
              id="rule-min-spend"
              value={draft.minSpend}
              invalid={Boolean(shown.minSpend)}
              onChange={(next) => onChange({ minSpend: next })}
            />
            <p className="mt-2 text-[13px] leading-[1.45] text-muted-foreground-2">
              Leave it empty to apply to any sale.
            </p>
          </Field>

          <div className="flex flex-col gap-8 sm:flex-row sm:gap-10">
            <Field label="Starts" htmlFor="rule-starts" layout="stacked">
              <Input
                id="rule-starts"
                type="date"
                className="tnum"
                value={draft.startsAt}
                onChange={(event) => onChange({ startsAt: event.target.value })}
              />
            </Field>
            <Field
              label="Ends"
              htmlFor="rule-ends"
              layout="stacked"
              error={shown.endsAt}
            >
              <Input
                id="rule-ends"
                type="date"
                className="tnum"
                value={draft.endsAt}
                aria-invalid={Boolean(shown.endsAt) || undefined}
                onChange={(event) => onChange({ endsAt: event.target.value })}
              />
            </Field>
          </div>

          <Field
            label="Priority"
            htmlFor="rule-priority"
            layout="stacked"
            error={shown.priority}
          >
            <Input
              id="rule-priority"
              className="tnum"
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              value={draft.priority}
              aria-invalid={Boolean(shown.priority) || undefined}
              onChange={(event) => onChange({ priority: event.target.value })}
            />
            <p className="mt-2 text-[13px] leading-[1.45] text-muted-foreground-2">
              The highest number runs first.
            </p>
          </Field>

          <Field label="Live" layout="stacked">
            <div className="flex items-center gap-4">
              <Switch
                checked={draft.active}
                onCheckedChange={(next: boolean) => onChange({ active: next })}
                aria-label="This rule is live"
              />
              <span className="text-[15px] text-foreground">
                {draft.active ? "Live" : "Off"}
              </span>
            </div>
          </Field>
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
          Save rule
        </Button>
        <Button variant="text" type="button" onClick={onCancel}>
          Cancel
        </Button>
        {showErrors && Object.keys(errors).length > 0 ? (
          <FieldError>Check the fields marked above.</FieldError>
        ) : null}
      </SheetFooter>
    </>
  )
}

export interface RulesSectionProps {
  rules: RuleForm[]
  games: GameRecord[]
  onSave: (rule: RuleForm) => void
  children?: React.ReactNode
}

export function RulesSection({ rules, games, onSave, children }: RulesSectionProps) {
  const [draft, setDraft] = React.useState<RuleForm | null>(null)
  const gameNames = Object.fromEntries(games.map((game) => [game.id, game.name]))

  return (
    <>
      {children}

      <ul className="mt-12" data-testid="loyalty-rules">
        {rules.length === 0 ? (
          <li className="py-3 text-[15px] text-muted-foreground-2">
            No rules yet. Base points are all a sale earns.
          </li>
        ) : null}
        {rules.map((rule) => (
          <li key={rule.key} className="border-b border-hairline-soft first:border-t">
            <button
              type="button"
              onClick={() => setDraft({ ...rule })}
              className="flex min-h-14 w-full items-center gap-4 py-3 text-left transition-colors duration-150 ease-gg hover:bg-row-hover"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] text-foreground">
                  {rule.name || "Untitled rule"}
                </span>
                <span className="block truncate text-[13px] text-muted-foreground-2">
                  {ruleSummary(rule, gameNames, WEEKDAYS)}
                </span>
              </span>
              <span className="tnum shrink-0 text-[15px] text-foreground">
                {isMultiplierType(rule.type) ? `x ${rule.value}` : `+${rule.value}`}
              </span>
              <span className="hidden shrink-0 sm:block">
                <Hint>{RULE_TYPE_LABEL[rule.type]}</Hint>
              </span>
              <Badge variant="outline">{rule.active ? "Live" : "Off"}</Badge>
              <span className="tnum shrink-0 font-mono text-[13px] text-muted-foreground-2">
                {rule.priority}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-6">
        <Button
          variant="text"
          type="button"
          onClick={() =>
            setDraft({
              key: `new-${Date.now()}`,
              id: "",
              name: "",
              type: "multiplier",
              games: [],
              kinds: [],
              minSpend: "",
              weekdays: [],
              value: "2",
              active: true,
              priority: "10",
              startsAt: "",
              endsAt: "",
            })
          }
        >
          Add a rule
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
            <SheetTitle>Rule</SheetTitle>
            <SheetDescription>
              What it pays, what it applies to and when it runs.
            </SheetDescription>
          </SheetHeader>
          {draft ? (
            <RuleFormBody
              draft={draft}
              games={games}
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
