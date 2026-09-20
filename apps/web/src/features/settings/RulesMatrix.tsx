/**
 * The pricing rules matrix.
 *
 * One hairline row per `pricing_rules` record, editable where it stands: the
 * percentages and the bands are what an admin actually changes, and making
 * them a form-in-a-dialog would put three taps between a decision and the
 * number. Wildcards print "Any" and an open-ended band prints "and up", so a
 * row reads as the sentence the evaluator acts on.
 *
 * From 900px it is the table. Below that the same rows are summaries with an
 * edit sheet behind them: twelve controls in a row is not a phone screen.
 */
import * as React from "react"
import { XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MicroLabel } from "@/components/ui/micro-label"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  bandLabel,
  poundsToPence,
  ROUNDING_STEPS,
  RULE_CARD_CONDITIONS,
  RULE_KINDS,
  RULE_RETRO_CONDITIONS,
  type FormErrors,
  type RuleForm,
} from "@/features/settings/mapping"
import type { GameRecord } from "@/lib/api/types"

export interface RulesMatrixProps {
  rules: RuleForm[]
  games: GameRecord[]
  errors: FormErrors
  onChange: (key: string, patch: Partial<RuleForm>) => void
  onAdd: () => void
  /** Only a row that has never been saved can be taken off again. */
  onRemove: (key: string) => void
}

const STEP_LABELS: Record<number, string> = { 25: "25p", 50: "50p", 100: "£1" }

function kindLabel(kind: string): string {
  if (!kind) return "Any kind"
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}

/** "NM" stays "NM"; "cib" reads as "Cib" would be wrong, so retro words do. */
function conditionLabel(condition: string): string {
  if (condition === "cib") return "CIB"
  if (condition === condition.toUpperCase()) return condition
  return condition.charAt(0).toUpperCase() + condition.slice(1)
}

/** "Single, NM, Pokemon" - only the parts that are not a wildcard. */
function appliesTo(rule: RuleForm, games: GameRecord[]): string {
  const game = games.find((row) => row.id === rule.game)?.name
  const parts = [
    kindLabel(rule.kind),
    game,
    rule.condition,
    rule.finish,
    rule.rarity,
  ].filter((part): part is string => Boolean(part))
  return parts.join(", ")
}

function ruleBandLabel(rule: RuleForm): string {
  const min = poundsToPence(rule.bandMin) ?? 0
  const max = poundsToPence(rule.bandMax)
  return bandLabel(min, max)
}

/**
 * What a cell's accessible name calls its row. Three single bands all read
 * as "Single" on their own, so the band goes in the name: a screen reader
 * hears which row it is in, and so does a test.
 */
function ruleName(rule: RuleForm, games: GameRecord[]): string {
  return `${appliesTo(rule, games)}, ${ruleBandLabel(rule)}`
}

/** A narrow cell input: no label of its own, so it carries an aria-label. */
function CellInput({
  label,
  value,
  onChange,
  invalid,
  width,
  placeholder,
  maxLength,
}: {
  label: string
  value: string
  onChange: (next: string) => void
  invalid?: boolean
  width: string
  placeholder?: string
  maxLength?: number
}) {
  return (
    <Input
      aria-label={label}
      aria-invalid={invalid || undefined}
      className={`tnum ${width}`}
      containerClassName={width}
      autoComplete="off"
      inputMode={maxLength === 3 ? "numeric" : "decimal"}
      maxLength={maxLength}
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

function GameSelect({
  rule,
  games,
  onChange,
}: {
  rule: RuleForm
  games: GameRecord[]
  onChange: (patch: Partial<RuleForm>) => void
}) {
  return (
    <Select
      value={rule.game || null}
      onValueChange={(next: string | null) => onChange({ game: next ?? "" })}
    >
      <SelectTrigger aria-label={`Game for the ${ruleName(rule, games)} rule`}>
        <SelectValue placeholder="Any">
          {(value: string) => games.find((row) => row.id === value)?.name ?? "Any"}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={null}>Any</SelectItem>
        {games.map((game) => (
          <SelectItem key={game.id} value={game.id}>
            {game.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function KindSelect({
  rule,
  onChange,
  label,
}: {
  rule: RuleForm
  onChange: (patch: Partial<RuleForm>) => void
  label: string
}) {
  return (
    <Select
      value={rule.kind || null}
      onValueChange={(next: string | null) => onChange({ kind: next ?? "" })}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue placeholder="Any">
          {(value: string) => (value ? kindLabel(value) : "Any")}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={null}>Any</SelectItem>
        {RULE_KINDS.map((kind) => (
          <SelectItem key={kind} value={kind}>
            {kindLabel(kind)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function ConditionSelect({
  rule,
  onChange,
  label,
}: {
  rule: RuleForm
  onChange: (patch: Partial<RuleForm>) => void
  label: string
}) {
  return (
    <Select
      value={rule.condition || null}
      onValueChange={(next: string | null) => onChange({ condition: next ?? "" })}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue placeholder="Any">
          {(value: string) => (value ? conditionLabel(value) : "Any")}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={null}>Any</SelectItem>
        <SelectGroup>
          <SelectLabel>Card</SelectLabel>
          {RULE_CARD_CONDITIONS.map((condition) => (
            <SelectItem key={condition} value={condition}>
              {condition}
            </SelectItem>
          ))}
        </SelectGroup>
        <SelectGroup>
          <SelectLabel>Retro</SelectLabel>
          {RULE_RETRO_CONDITIONS.map((condition) => (
            <SelectItem key={condition} value={condition}>
              {conditionLabel(condition)}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

function StepSelect({
  rule,
  onChange,
  label,
}: {
  rule: RuleForm
  onChange: (patch: Partial<RuleForm>) => void
  label: string
}) {
  return (
    <Select
      value={String(rule.rounding)}
      onValueChange={(next: string | null) =>
        onChange({ rounding: Number(next ?? 25) as RuleForm["rounding"] })
      }
    >
      <SelectTrigger aria-label={label}>
        <SelectValue>{(value: string) => STEP_LABELS[Number(value)] ?? "25p"}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {ROUNDING_STEPS.map((step) => (
          <SelectItem key={step} value={String(step)}>
            {STEP_LABELS[step]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** The whole rule, for a phone. Same state, one control under the next. */
function RuleSheet({
  rule,
  games,
  errors,
  onChange,
  onClose,
  onRemove,
}: {
  rule: RuleForm
  games: GameRecord[]
  errors: FormErrors
  onChange: (patch: Partial<RuleForm>) => void
  onClose: () => void
  onRemove: () => void
}) {
  const error = (field: string) => errors[`rules.${rule.key}.${field}`]

  return (
    <>
      <SheetHeader>
        <SheetTitle>{appliesTo(rule, games)}</SheetTitle>
        <SheetDescription>
          What this rule applies to, and what it pays. The higher priority wins
          when two rules match.
        </SheetDescription>
      </SheetHeader>
      <SheetBody>
        <div className="flex flex-col gap-8">
          <Field label="Game" layout="stacked">
            <GameSelect rule={rule} games={games} onChange={onChange} />
          </Field>
          <Field label="Kind" layout="stacked">
            <KindSelect rule={rule} onChange={onChange} label="Kind" />
          </Field>
          <Field label="Condition" layout="stacked">
            <ConditionSelect rule={rule} onChange={onChange} label="Condition" />
          </Field>
          <Field label="Finish" htmlFor={`sheet-finish-${rule.key}`} layout="stacked">
            <Input
              id={`sheet-finish-${rule.key}`}
              autoComplete="off"
              placeholder="Any"
              value={rule.finish}
              onChange={(event) => onChange({ finish: event.target.value })}
            />
          </Field>
          <Field label="Rarity" htmlFor={`sheet-rarity-${rule.key}`} layout="stacked">
            <Input
              id={`sheet-rarity-${rule.key}`}
              autoComplete="off"
              placeholder="Any"
              value={rule.rarity}
              onChange={(event) => onChange({ rarity: event.target.value })}
            />
          </Field>
          <Field
            label="Band from"
            htmlFor={`sheet-from-${rule.key}`}
            layout="stacked"
            error={error("bandMin")}
          >
            <Input
              id={`sheet-from-${rule.key}`}
              className="tnum"
              inputMode="decimal"
              autoComplete="off"
              aria-invalid={Boolean(error("bandMin")) || undefined}
              value={rule.bandMin}
              onChange={(event) => onChange({ bandMin: event.target.value })}
            />
          </Field>
          <Field
            label="Band to"
            hint="Empty is and up"
            htmlFor={`sheet-to-${rule.key}`}
            layout="stacked"
            error={error("bandMax")}
          >
            <Input
              id={`sheet-to-${rule.key}`}
              className="tnum"
              inputMode="decimal"
              autoComplete="off"
              placeholder="and up"
              aria-invalid={Boolean(error("bandMax")) || undefined}
              value={rule.bandMax}
              onChange={(event) => onChange({ bandMax: event.target.value })}
            />
          </Field>
          <Field
            label="Cash"
            htmlFor={`sheet-cash-${rule.key}`}
            layout="stacked"
            error={error("cashPct")}
          >
            <Input
              id={`sheet-cash-${rule.key}`}
              className="tnum"
              inputMode="numeric"
              maxLength={3}
              trailingHint="%"
              aria-invalid={Boolean(error("cashPct")) || undefined}
              value={rule.cashPct}
              onChange={(event) => onChange({ cashPct: event.target.value })}
            />
          </Field>
          <Field
            label="Credit"
            htmlFor={`sheet-credit-${rule.key}`}
            layout="stacked"
            error={error("creditPct")}
          >
            <Input
              id={`sheet-credit-${rule.key}`}
              className="tnum"
              inputMode="numeric"
              maxLength={3}
              trailingHint="%"
              aria-invalid={Boolean(error("creditPct")) || undefined}
              value={rule.creditPct}
              onChange={(event) => onChange({ creditPct: event.target.value })}
            />
          </Field>
          <Field label="Rounding step" layout="stacked">
            <StepSelect rule={rule} onChange={onChange} label="Rounding step" />
          </Field>
          <Field
            label="Priority"
            htmlFor={`sheet-priority-${rule.key}`}
            layout="stacked"
            error={error("priority")}
          >
            <Input
              id={`sheet-priority-${rule.key}`}
              className="tnum"
              inputMode="numeric"
              maxLength={4}
              aria-invalid={Boolean(error("priority")) || undefined}
              value={rule.priority}
              onChange={(event) => onChange({ priority: event.target.value })}
            />
          </Field>
          <div className="flex items-center justify-between gap-6">
            <MicroLabel>Active</MicroLabel>
            <Switch
              checked={rule.active}
              onCheckedChange={(checked: boolean) => onChange({ active: checked })}
              aria-label="Active"
            />
          </div>
        </div>
      </SheetBody>
      <SheetFooter>
        <Button onClick={onClose}>Done</Button>
        {rule.id === "" ? (
          <Button variant="text-destructive" onClick={onRemove}>
            Remove this rule
          </Button>
        ) : null}
      </SheetFooter>
    </>
  )
}

export function RulesMatrix({
  rules,
  games,
  errors,
  onChange,
  onAdd,
  onRemove,
}: RulesMatrixProps) {
  const [editing, setEditing] = React.useState<string | null>(null)
  const openRule = rules.find((rule) => rule.key === editing) ?? null
  const error = (rule: RuleForm, field: string) => errors[`rules.${rule.key}.${field}`]
  const patch = (rule: RuleForm) => (next: Partial<RuleForm>) => onChange(rule.key, next)

  return (
    <div data-testid="rules-matrix">
      {/* From 900px: the matrix itself. */}
      <div className="hidden min-[900px]:block">
        {/* Twelve columns in a 1,040px column: the cells lose 4px of side
            padding each so every one of them fits without a sideways scroll. */}
        <Table className="[&_td]:px-2 [&_th]:px-2">
          <TableHeader>
            <TableRow>
              <TableHead>Game</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Condition</TableHead>
              <TableHead>Finish</TableHead>
              <TableHead>Rarity</TableHead>
              <TableHead numeric>Band from</TableHead>
              <TableHead numeric>Band to</TableHead>
              <TableHead numeric>Cash</TableHead>
              <TableHead numeric>Credit</TableHead>
              <TableHead>Step</TableHead>
              <TableHead numeric>Priority</TableHead>
              <TableHead>Active</TableHead>
              <TableHead>
                <span className="sr-only">Remove</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.map((rule) => (
              <TableRow key={rule.key} data-testid="rule-row">
                <TableCell className="w-[6.5rem]">
                  <GameSelect rule={rule} games={games} onChange={patch(rule)} />
                </TableCell>
                <TableCell className="w-[6.5rem]">
                  <KindSelect
                    rule={rule}
                    onChange={patch(rule)}
                    label={`Kind for the ${ruleName(rule, games)} rule`}
                  />
                </TableCell>
                <TableCell className="w-[5.5rem]">
                  <ConditionSelect
                    rule={rule}
                    onChange={patch(rule)}
                    label={`Condition for the ${ruleName(rule, games)} rule`}
                  />
                </TableCell>
                <TableCell>
                  <CellInput
                    label={`Finish for the ${ruleName(rule, games)} rule`}
                    width="w-[4.5rem]"
                    placeholder="Any"
                    value={rule.finish}
                    onChange={(next) => onChange(rule.key, { finish: next })}
                  />
                </TableCell>
                <TableCell>
                  <CellInput
                    label={`Rarity for the ${ruleName(rule, games)} rule`}
                    width="w-[4.5rem]"
                    placeholder="Any"
                    value={rule.rarity}
                    onChange={(next) => onChange(rule.key, { rarity: next })}
                  />
                </TableCell>
                <TableCell numeric>
                  <CellInput
                    label={`Band from for the ${ruleName(rule, games)} rule, in pounds`}
                    width="w-[4.5rem]"
                    value={rule.bandMin}
                    invalid={Boolean(error(rule, "bandMin"))}
                    onChange={(next) => onChange(rule.key, { bandMin: next })}
                  />
                </TableCell>
                <TableCell numeric>
                  <CellInput
                    label={`Band to for the ${ruleName(rule, games)} rule, in pounds`}
                    width="w-[4.5rem]"
                    placeholder="and up"
                    value={rule.bandMax}
                    invalid={Boolean(error(rule, "bandMax"))}
                    onChange={(next) => onChange(rule.key, { bandMax: next })}
                  />
                </TableCell>
                <TableCell numeric>
                  <CellInput
                    label={`Cash percent for the ${ruleName(rule, games)} rule`}
                    width="w-[3rem]"
                    maxLength={3}
                    value={rule.cashPct}
                    invalid={Boolean(error(rule, "cashPct"))}
                    onChange={(next) => onChange(rule.key, { cashPct: next })}
                  />
                </TableCell>
                <TableCell numeric>
                  <CellInput
                    label={`Credit percent for the ${ruleName(rule, games)} rule`}
                    width="w-[3rem]"
                    maxLength={3}
                    value={rule.creditPct}
                    invalid={Boolean(error(rule, "creditPct"))}
                    onChange={(next) => onChange(rule.key, { creditPct: next })}
                  />
                </TableCell>
                <TableCell className="w-[5.5rem]">
                  <StepSelect
                    rule={rule}
                    onChange={patch(rule)}
                    label={`Rounding step for the ${ruleName(rule, games)} rule`}
                  />
                </TableCell>
                <TableCell numeric>
                  <CellInput
                    label={`Priority for the ${ruleName(rule, games)} rule`}
                    width="w-[3rem]"
                    maxLength={4}
                    value={rule.priority}
                    invalid={Boolean(error(rule, "priority"))}
                    onChange={(next) => onChange(rule.key, { priority: next })}
                  />
                </TableCell>
                <TableCell>
                  <Switch
                    checked={rule.active}
                    onCheckedChange={(checked: boolean) =>
                      onChange(rule.key, { active: checked })
                    }
                    aria-label={`Active: the ${ruleName(rule, games)} rule`}
                  />
                </TableCell>
                <TableCell>
                  {rule.id === "" ? (
                    <Button
                      variant="ghost-icon"
                      aria-label={`Remove the new ${kindLabel(rule.kind)} rule`}
                      onClick={() => onRemove(rule.key)}
                    >
                      <XIcon />
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Below 900px: a row you can read, with the whole rule behind it. */}
      <ul className="min-[900px]:hidden">
        {rules.map((rule) => (
          <li
            key={rule.key}
            data-testid="rule-row-small"
            className="flex items-center justify-between gap-4 border-b border-hairline-soft py-4"
          >
            <span className="flex min-w-0 flex-col gap-1">
              <span className="truncate text-[15px] text-foreground">
                {appliesTo(rule, games)}
              </span>
              <span className="tnum text-[13px] text-muted-foreground-2">
                {ruleBandLabel(rule)} &middot; {rule.cashPct}% cash &middot;{" "}
                {rule.creditPct}% credit
                {rule.active ? "" : " · Off"}
              </span>
            </span>
            <Button variant="text" onClick={() => setEditing(rule.key)}>
              Edit
            </Button>
          </li>
        ))}
      </ul>

      <div className="mt-6 flex flex-wrap items-center gap-8">
        <Button variant="text" onClick={onAdd}>
          Add a rule
        </Button>
        <span className="text-[13px] text-muted-foreground-2">
          A rule is never deleted. Switch it off and the bands that priced last
          week still read back.
        </span>
      </div>

      <Sheet
        open={openRule !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setEditing(null)
        }}
      >
        <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
          {openRule ? (
            <RuleSheet
              rule={openRule}
              games={games}
              errors={errors}
              onChange={patch(openRule)}
              onClose={() => setEditing(null)}
              onRemove={() => {
                onRemove(openRule.key)
                setEditing(null)
              }}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  )
}
