/**
 * Offers, on the Loyalty screen (docs/api-contract-launch.md, section 2):
 * one list of plain sentences with a live example under each, an on and
 * off switch beside each, and "New offer" starting from the contract's
 * templates.
 *
 * The first row is the programme's own rate ("Earn 10 points for every
 * £1"). Every other row is a `loyalty_rules` row. Each one saves on its own
 * the moment it is saved or switched, as the rewards beside it do, so what
 * the list shows is what the till prices with.
 *
 * Branches are picked from a searchable list of the category tree's paths,
 * items by search, till products from the whole list (there are a handful),
 * and days as chips. The example in the sheet answers as the blanks are
 * filled in.
 */
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import type { LoyaltyProgramme } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Field, FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Hint } from "@/components/ui/micro-label"
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
import { refusalOrFallback } from "@/lib/api/refusal"
import {
  getOfferItems,
  listOfferProducts,
  offerBranchesQuery,
  searchOfferItems,
  type OfferItem,
} from "@/lib/api/offers"
import {
  OFFER_TEMPLATES,
  emptyOffer,
  hasOlderConditions,
  multiplies,
  offerExample,
  offerSentence,
  parseRate,
  rateExample,
  rateSentence,
  takesThings,
  validateOffer,
  type OfferForm,
  type OfferNames,
  type OfferTemplate,
} from "@/features/loyalty/offers"
import type { GameRecord } from "@/lib/api/types"

/** The shop's week starts on a Monday; 0 is Sunday. */
const WEEK = [1, 2, 3, 4, 5, 6, 0]
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function Note({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <p id={id} className="mt-2 max-w-[48ch] text-[13px] leading-[1.45] text-muted-foreground-2">
      {children}
    </p>
  )
}

// ---------------------------------------------------------------------------
// Picking branches and items
// ---------------------------------------------------------------------------

/** The chosen ones as pressed chips (tap one to take it off), then a search for more. */
function ChosenChips({
  label,
  chosen,
  nameOf,
  onRemove,
}: {
  label: string
  chosen: string[]
  nameOf: (id: string) => string
  onRemove: (id: string) => void
}) {
  if (chosen.length === 0) return null
  return (
    <ChipGroup
      aria-label={label}
      multiple
      value={chosen}
      onValueChange={(next: string[]) => {
        const gone = chosen.find((id) => !next.includes(id))
        if (gone) onRemove(gone)
      }}
      className="mb-3"
    >
      {chosen.map((id) => (
        <Chip key={id} value={id}>
          {nameOf(id)}
        </Chip>
      ))}
    </ChipGroup>
  )
}

function SearchResults({
  rows,
  onPick,
  empty,
  testId,
}: {
  rows: { id: string; label: string; detail?: string }[]
  onPick: (id: string) => void
  empty: string | null
  testId: string
}) {
  if (rows.length === 0) {
    return empty ? <p className="mt-3 text-[13px] text-muted-foreground-2">{empty}</p> : null
  }
  return (
    <ul className="mt-3" data-testid={testId}>
      {rows.map((row) => (
        <li key={row.id} className="border-b border-hairline-soft first:border-t">
          <button
            type="button"
            onClick={() => onPick(row.id)}
            className="flex min-h-12 w-full items-center justify-between gap-4 py-2 text-left transition-colors duration-150 ease-gg hover:bg-row-hover"
          >
            <span className="min-w-0 truncate text-[15px] text-foreground">{row.label}</span>
            {row.detail ? <Hint className="tnum shrink-0">{row.detail}</Hint> : null}
          </button>
        </li>
      ))}
    </ul>
  )
}

function BranchPicker({
  chosen,
  names,
  branches,
  onChange,
}: {
  chosen: string[]
  names: OfferNames
  branches: { id: string; path: string; active: boolean }[]
  onChange: (next: string[]) => void
}) {
  const [query, setQuery] = React.useState("")
  const needle = query.trim().toLowerCase()
  const rows = needle
    ? branches
        .filter((branch) => branch.active && !chosen.includes(branch.id))
        .filter((branch) => branch.path.toLowerCase().includes(needle))
        .slice(0, 8)
        .map((branch) => ({ id: branch.id, label: branch.path }))
    : []
  return (
    <Field label="Branches" htmlFor="offer-branch-search" layout="stacked">
      <ChosenChips
        label="Chosen branches"
        chosen={chosen}
        nameOf={(id) => names.branches[id]?.path ?? "A branch"}
        onRemove={(id) => onChange(chosen.filter((entry) => entry !== id))}
      />
      <Input
        id="offer-branch-search"
        autoComplete="off"
        placeholder="Search branches, for example Pokémon"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <SearchResults
        rows={rows}
        testId="offer-branch-results"
        empty={needle ? "No branch matches that. Check the spelling." : null}
        onPick={(id) => {
          onChange([...chosen, id])
          setQuery("")
        }}
      />
      <Note>A branch takes in everything beneath it.</Note>
    </Field>
  )
}

function ItemPicker({
  chosen,
  names,
  onChange,
  onSeen,
}: {
  chosen: string[]
  names: OfferNames
  onChange: (next: string[]) => void
  onSeen: (items: OfferItem[]) => void
}) {
  const [query, setQuery] = React.useState("")
  const deferred = React.useDeferredValue(query.trim())
  const { data = [], isFetching } = useQuery({
    queryKey: ["offer-items", deferred],
    queryFn: () => searchOfferItems(deferred),
    enabled: deferred.length >= 2,
    staleTime: 10_000,
  })
  const rows = deferred.length >= 2
    ? data
        .filter((item) => !chosen.includes(item.id))
        .map((item) => ({ id: item.id, label: item.title, detail: item.sku }))
    : []
  return (
    <Field label="Items" htmlFor="offer-item-search" layout="stacked">
      <ChosenChips
        label="Chosen items"
        chosen={chosen}
        nameOf={(id) => names.items[id]?.title ?? "An item"}
        onRemove={(id) => onChange(chosen.filter((entry) => entry !== id))}
      />
      <Input
        id="offer-item-search"
        autoComplete="off"
        placeholder="Search stock by title or code"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <SearchResults
        rows={rows}
        testId="offer-item-results"
        empty={deferred.length >= 2 && !isFetching ? "No stock matches that." : null}
        onPick={(id) => {
          const item = data.find((row) => row.id === id)
          if (item) onSeen([item])
          onChange([...chosen, id])
          setQuery("")
        }}
      />
    </Field>
  )
}

// ---------------------------------------------------------------------------
// The offer sheet
// ---------------------------------------------------------------------------

function OfferFormBody({
  draft,
  names,
  programme,
  branches,
  products,
  onChange,
  onSeen,
  onSave,
  onCancel,
  saving,
  error,
}: {
  draft: OfferForm
  names: OfferNames
  programme: LoyaltyProgramme
  branches: { id: string; path: string; active: boolean }[]
  products: { id: string; name: string; active: boolean }[]
  onChange: (patch: Partial<OfferForm>) => void
  onSeen: (items: OfferItem[]) => void
  onSave: () => void
  onCancel: () => void
  saving: boolean
  error: string | null
}) {
  const [showErrors, setShowErrors] = React.useState(false)
  const errors = validateOffer(draft)
  const shown = showErrors ? errors : {}
  const times = multiplies(draft.type)
  const example = offerExample(draft, programme, names)

  return (
    <>
      <SheetBody>
        <div className="flex flex-col gap-8">
          <Field
            label={times ? "Times points" : "Bonus points"}
            htmlFor="offer-value"
            layout="stacked"
            error={shown.value}
          >
            <Input
              id="offer-value"
              className="tnum"
              inputMode="decimal"
              autoComplete="off"
              maxLength={6}
              trailingHint={times ? "times" : "points"}
              value={draft.value}
              aria-invalid={Boolean(shown.value) || undefined}
              onChange={(event) => onChange({ value: event.target.value })}
            />
          </Field>

          {takesThings(draft.type) ? (
            <>
              <BranchPicker
                chosen={draft.categories}
                names={names}
                branches={branches}
                onChange={(next) => onChange({ categories: next })}
              />
              <ItemPicker
                chosen={draft.items}
                names={names}
                onSeen={onSeen}
                onChange={(next) => onChange({ items: next })}
              />
              <Field label="Till products" layout="stacked">
                <ChipGroup
                  aria-label="Till products this offer is on"
                  multiple
                  value={draft.products}
                  onValueChange={(next: string[]) => onChange({ products: next })}
                >
                  {products
                    .filter((product) => product.active || draft.products.includes(product.id))
                    .map((product) => (
                      <Chip key={product.id} value={product.id}>
                        {product.name}
                      </Chip>
                    ))}
                </ChipGroup>
                {shown.things ? <FieldError>{shown.things}</FieldError> : null}
              </Field>
              <Field label="Days" layout="stacked" error={shown.weekdays}>
                <ChipGroup
                  aria-label="Days this offer runs on"
                  multiple
                  value={draft.weekdays.map(String)}
                  onValueChange={(next: string[]) => onChange({ weekdays: next.map(Number) })}
                >
                  {WEEK.map((day) => (
                    <Chip key={day} value={String(day)}>
                      {DAY_SHORT[day]}
                    </Chip>
                  ))}
                </ChipGroup>
                <Hint className="mt-2 block">
                  {draft.weekdays.length === 0 ? "Every day" : "Only these days"}
                </Hint>
              </Field>
            </>
          ) : null}

          <div className="flex flex-col gap-8 sm:flex-row sm:gap-10">
            <Field label="From" htmlFor="offer-starts" layout="stacked">
              <Input
                id="offer-starts"
                type="date"
                className="tnum"
                value={draft.startsAt}
                onChange={(event) => onChange({ startsAt: event.target.value })}
              />
            </Field>
            <Field label="Until" htmlFor="offer-ends" layout="stacked" error={shown.endsAt}>
              <Input
                id="offer-ends"
                type="date"
                className="tnum"
                value={draft.endsAt}
                aria-invalid={Boolean(shown.endsAt) || undefined}
                onChange={(event) => onChange({ endsAt: event.target.value })}
              />
              <Note>Leave both empty for an offer that runs until it is switched off.</Note>
            </Field>
          </div>

          <div className="flex items-start gap-4">
            <Switch
              checked={draft.paidMembersOnly}
              onCheckedChange={(next: boolean) => onChange({ paidMembersOnly: next })}
              aria-label={`Only for ${names.paidTier || "paid-plan"} members`}
            />
            <p className="text-[15px] leading-[1.5] text-foreground">
              Only for {names.paidTier || "paid-plan"} members
            </p>
          </div>
          <div className="flex items-start gap-4">
            <Switch
              checked={draft.active}
              onCheckedChange={(next: boolean) => onChange({ active: next })}
              aria-label="This offer is on"
            />
            <p className="text-[15px] leading-[1.5] text-foreground">{draft.active ? "On" : "Off"}</p>
          </div>

          {hasOlderConditions(draft) ? (
            <div>
              <p className="max-w-[48ch] text-[13px] leading-[1.45] text-muted-foreground">
                This offer was set up before branches: it is also limited by game, kind or
                spend, as its sentence says.
              </p>
              <Button
                variant="text"
                type="button"
                onClick={() => onChange({ games: [], kinds: [], minSpend: null })}
              >
                Take those limits off
              </Button>
            </div>
          ) : null}

          <div className="border-t border-hairline-soft pt-5">
            <p className="text-[15px] leading-[1.5] text-foreground">{offerSentence(draft, names)}</p>
            <p data-testid="offer-sheet-example" aria-live="polite" className="mt-1 text-[13px] leading-[1.45] text-muted-foreground">
              {example.sentence}
            </p>
          </div>
        </div>
      </SheetBody>
      <SheetFooter>
        <Button
          type="button"
          trailingArrow
          loading={saving}
          onClick={() => {
            setShowErrors(true)
            if (Object.keys(errors).length > 0) return
            onSave()
          }}
        >
          Save offer
        </Button>
        <Button variant="text" type="button" onClick={onCancel}>
          Cancel
        </Button>
        {error ? <FieldError>{error}</FieldError> : null}
        {!error && showErrors && Object.keys(errors).length > 0 ? (
          <FieldError>Check the fields marked above.</FieldError>
        ) : null}
      </SheetFooter>
    </>
  )
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

export interface OffersSectionProps {
  offers: OfferForm[]
  /** The programme as it stands, for the examples. */
  programme: LoyaltyProgramme
  /** The paid plan's name, for "Guild+ members only". */
  paidTier: string
  games: GameRecord[]
  /** Saves one offer; refuses with the server's sentence. */
  onSaveOffer: (form: OfferForm, names: OfferNames) => Promise<void>
  /** Saves the programme's rate. */
  onSaveRate: (rate: number) => Promise<void>
}

export function OffersSection({
  offers,
  programme,
  paidTier,
  games,
  onSaveOffer,
  onSaveRate,
}: OffersSectionProps) {
  const [draft, setDraft] = React.useState<OfferForm | null>(null)
  const [choosing, setChoosing] = React.useState(false)
  const [rateOpen, setRateOpen] = React.useState(false)
  const [rateText, setRateText] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [rowError, setRowError] = React.useState<{ key: string; message: string } | null>(null)
  const [seen, setSeen] = React.useState<Record<string, OfferItem>>({})

  const { data: branches = [] } = useQuery(offerBranchesQuery)
  const { data: products = [] } = useQuery({
    queryKey: ["offer-products"],
    queryFn: listOfferProducts,
    staleTime: 60_000,
  })
  const itemIds = [...new Set(offers.flatMap((offer) => offer.items))].sort()
  const { data: namedItems = [] } = useQuery({
    queryKey: ["offer-named-items", itemIds.join(",")],
    queryFn: () => getOfferItems(itemIds),
    enabled: itemIds.length > 0,
    staleTime: 60_000,
  })

  const names: OfferNames = React.useMemo(
    () => ({
      branches: Object.fromEntries(
        branches.map((branch) => [branch.id, { name: branch.name, path: branch.path, lineage: branch.lineage }])
      ),
      items: Object.fromEntries(
        [...namedItems, ...Object.values(seen)].map((item) => [item.id, { title: item.title, price: item.price }])
      ),
      products: Object.fromEntries(products.map((product) => [product.id, { name: product.name, price: product.price }])),
      games: Object.fromEntries(games.map((game) => [game.id, game.name])),
      paidTier,
    }),
    [branches, namedItems, seen, products, games, paidTier]
  )

  async function save(form: OfferForm, fromList: boolean) {
    setSaving(true)
    setError(null)
    setRowError(null)
    try {
      await onSaveOffer(form, names)
      if (!fromList) setDraft(null)
    } catch (cause) {
      const message = refusalOrFallback(cause, "That offer did not save. Try it again.")
      if (fromList) setRowError({ key: form.key, message })
      else setError(message)
    } finally {
      setSaving(false)
    }
  }

  const rate = parseRate(rateText)
  const rateShown = rateOpen ? (rate ?? programme.earnPerPoundSales) : programme.earnPerPoundSales

  return (
    <>
      <ul data-testid="loyalty-offers">
        <li className="border-b border-hairline-soft first:border-t" data-testid="offer-rate">
          <div className="flex min-h-14 items-center gap-4 py-3">
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] text-foreground">
                {rateSentence(programme.earnPerPoundSales)}
              </span>
              <span className="block text-[13px] text-muted-foreground-2">
                {rateExample(programme).sentence}
              </span>
            </span>
            <Button
              variant="text"
              type="button"
              onClick={() => {
                setRateText(String(programme.earnPerPoundSales))
                setError(null)
                setRateOpen(true)
              }}
            >
              Change
            </Button>
          </div>
        </li>
        {offers.map((offer) => {
          const sentence = offerSentence(offer, names)
          return (
            <li
              key={offer.key}
              className="border-b border-hairline-soft first:border-t"
              data-testid="offer-row"
            >
              <div className="flex min-h-14 items-center gap-4">
                <button
                  type="button"
                  onClick={() => {
                    setError(null)
                    setDraft({ ...offer })
                  }}
                  className="min-w-0 flex-1 py-3 text-left transition-colors duration-150 ease-gg hover:bg-row-hover"
                >
                  <span className="block text-[15px] text-foreground">{sentence}</span>
                  <span className="block text-[13px] text-muted-foreground-2" data-testid="offer-row-example">
                    {offerExample(offer, programme, names).sentence}
                  </span>
                </button>
                <span className="flex shrink-0 items-center gap-3">
                  <Hint>{offer.active ? "On" : "Off"}</Hint>
                  <Switch
                    checked={offer.active}
                    disabled={saving}
                    onCheckedChange={(next: boolean) => void save({ ...offer, active: next }, true)}
                    aria-label={`${sentence}: on`}
                  />
                </span>
              </div>
              {rowError?.key === offer.key ? (
                <p role="alert" className="pb-3 text-[13px] leading-[1.45] text-destructive">
                  {rowError.message}
                </p>
              ) : null}
            </li>
          )
        })}
      </ul>

      <div className="mt-6">
        <Button
          variant="text"
          type="button"
          onClick={() => {
            setError(null)
            setChoosing(true)
          }}
        >
          New offer
        </Button>
      </div>

      {/* ---- The templates ---- */}
      <Sheet open={choosing} onOpenChange={setChoosing}>
        <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle>New offer</SheetTitle>
            <SheetDescription>Pick the sentence, then fill in the blanks.</SheetDescription>
          </SheetHeader>
          <SheetBody>
            <ul data-testid="offer-templates">
              {OFFER_TEMPLATES.map((template) => (
                <li key={template.template} className="border-b border-hairline-soft first:border-t">
                  <button
                    type="button"
                    onClick={() => {
                      setChoosing(false)
                      setDraft(emptyOffer(template.template as OfferTemplate, `new-${Date.now()}`))
                    }}
                    className="flex min-h-14 w-full items-center py-3 text-left text-[15px] text-foreground transition-colors duration-150 ease-gg hover:bg-row-hover"
                  >
                    {template.sentence}
                  </button>
                </li>
              ))}
            </ul>
          </SheetBody>
        </SheetContent>
      </Sheet>

      {/* ---- One offer ---- */}
      <Sheet
        open={draft !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setDraft(null)
        }}
      >
        <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle>Offer</SheetTitle>
            <SheetDescription>What it pays, what it is on and when it runs.</SheetDescription>
          </SheetHeader>
          {draft ? (
            <OfferFormBody
              draft={draft}
              names={names}
              programme={programme}
              branches={branches}
              products={products}
              saving={saving}
              error={error}
              onSeen={(items) =>
                setSeen((current) => ({ ...current, ...Object.fromEntries(items.map((item) => [item.id, item])) }))
              }
              onChange={(patch) => setDraft((current) => (current ? { ...current, ...patch } : current))}
              onSave={() => void save(draft, false)}
              onCancel={() => setDraft(null)}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      {/* ---- The programme's rate ---- */}
      <Sheet open={rateOpen} onOpenChange={setRateOpen}>
        <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle>Points for every £1</SheetTitle>
            <SheetDescription>What every sale to a Guild member earns before any offer.</SheetDescription>
          </SheetHeader>
          <SheetBody>
            <Field
              label="Points"
              htmlFor="offer-rate"
              layout="stacked"
              error={rateText && rate === null ? "A rate is a whole number of points, up to 1,000." : undefined}
            >
              <Input
                id="offer-rate"
                className="tnum"
                inputMode="numeric"
                autoComplete="off"
                maxLength={4}
                trailingHint="per £1"
                value={rateText}
                aria-invalid={Boolean(rateText && rate === null) || undefined}
                onChange={(event) => setRateText(event.target.value)}
              />
            </Field>
            <p className="mt-6 text-[15px] leading-[1.5] text-foreground">{rateSentence(rateShown)}</p>
            <p className="mt-1 text-[13px] leading-[1.45] text-muted-foreground">
              {rateExample({ ...programme, earnPerPoundSales: rateShown }).sentence}
            </p>
          </SheetBody>
          <SheetFooter>
            <Button
              type="button"
              trailingArrow
              loading={saving}
              disabled={rate === null}
              onClick={async () => {
                if (rate === null) return
                setSaving(true)
                setError(null)
                try {
                  await onSaveRate(rate)
                  setRateOpen(false)
                } catch (cause) {
                  setError(refusalOrFallback(cause, "The rate did not save. Try it again."))
                } finally {
                  setSaving(false)
                }
              }}
            >
              Save rate
            </Button>
            <Button variant="text" type="button" onClick={() => setRateOpen(false)}>
              Cancel
            </Button>
            {error ? <FieldError>{error}</FieldError> : null}
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  )
}
