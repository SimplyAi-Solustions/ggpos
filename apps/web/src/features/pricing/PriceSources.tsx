/**
 * The side-by-side source view: every place the shop could get a value from,
 * in the order it tries them, with the one it used marked.
 *
 * docs/PLAN.md: "Staff see all available sources side by side on the line
 * with the chosen one marked, and can pick another with a reason." Hairline
 * rows, no boxes, one figure per row in Jost tabular with its evidence
 * underneath, and at most two text actions.
 */
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  adjustForCondition,
  formatGBP,
  type CardCondition,
  type PriceSource,
} from "@gg/shared"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MicroLabel } from "@/components/ui/micro-label"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import {
  addRetroUkComp,
  addUkComp,
  cardPricesQuery,
  priceKeys,
  refreshPrices,
  refreshRetroPrices,
  retroPricesQuery,
  useFx,
  usePricingSettings,
} from "@/lib/api/prices"
import { refusalOrFallback } from "@/lib/api/refusal"
import type { PriceView, UkCompInput } from "@/lib/api/types"
import {
  fxWarning,
  sourceRows,
  type SourceRowView,
} from "@/features/pricing/sources"
import {
  todayForInput,
  validateComp,
  type CompErrors,
  type CompFormValues,
} from "@/features/pricing/comp-form"

/** What is being valued: a card in a finish, or a retro title at a completeness. */
export interface PriceSubject {
  kind: "card" | "retro"
  /** A `cards` id or a `retro_titles` id. */
  id: string
  /** The card's finish, or the retro title's completeness. */
  finish?: string
  /** Cards only: NM to DMG, for the condition-adjusted figure. */
  condition?: string
  /** The game's key, so One Piece's TCGplayer row can say "(OPTCG)". */
  gameKey?: string
  /** What it is, for the sheet's description line. */
  title?: string
}

export interface PriceSourcesProps {
  subject: PriceSubject
  /**
   * Called when a staff member picks a source other than the chosen one. The
   * reason travels with it: on a buy-in line it becomes the line's override
   * reason, on Add stock it only changes the figure the suggestion uses.
   */
  onPick?: (choice: { source: PriceSource; gbp: number; reason: string }) => void
  /** The source a staff member has already picked by hand, if any. */
  picked?: PriceSource | null
  /** Hides Refresh and Add UK comp where the screen is read-only. */
  actions?: boolean
  className?: string
}

/** The dot that marks the row in use. A mark, never a colour on its own. */
function ChosenDot({ on }: { on: boolean }) {
  return (
    <span aria-hidden="true" className="flex w-3 shrink-0 justify-start">
      {on ? <span className="size-1.5 rounded-full bg-foreground" /> : null}
    </span>
  )
}

/** Stale is a state, so it gets a word as well as the pop edge. */
function StaleChip() {
  return (
    <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-[var(--pop)] px-2 font-mono text-[11px] font-bold tracking-[0.16em] text-destructive uppercase">
      Stale
    </span>
  )
}

function SourceRow({
  row,
  inUse,
  picked,
  onPick,
}: {
  row: SourceRowView
  inUse: boolean
  picked: boolean
  onPick?: () => void
}) {
  return (
    <li
      data-testid="price-source"
      data-source={row.source}
      data-chosen={inUse || undefined}
      className="border-b border-hairline-soft py-3 first:border-t"
    >
      <div className="flex items-baseline justify-between gap-6">
        <span className="flex min-w-0 items-baseline gap-2">
          <ChosenDot on={inUse} />
          <MicroLabel tone={inUse ? "ink" : "default"}>{row.label}</MicroLabel>
          {inUse ? (
            <MicroLabel tone="hint">{picked ? "Picked" : "Chosen"}</MicroLabel>
          ) : null}
          {row.stale ? <StaleChip /> : null}
        </span>
        <span className="flex shrink-0 items-baseline gap-6">
          {row.gbp === null ? (
            <span className="text-[15px] text-muted-foreground-2">No value</span>
          ) : (
            <span className="tnum text-[15px] text-foreground">
              {formatGBP(row.gbp)}
            </span>
          )}
          {onPick && row.gbp !== null && !inUse ? (
            <Button variant="text" type="button" onClick={onPick}>
              Use this
            </Button>
          ) : null}
        </span>
      </div>
      {row.detail ? (
        <p className="mt-1 max-w-[56ch] pl-5 text-[13px] leading-[1.45] text-muted-foreground-2">
          {row.detail}
          {row.evidenceUrl ? (
            <>
              {" "}
              <a
                href={row.evidenceUrl}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground underline underline-offset-4"
              >
                Listing
              </a>
            </>
          ) : null}
        </p>
      ) : null}
    </li>
  )
}

/** Why this source rather than the one the rules picked. */
function PickSheet({
  open,
  onOpenChange,
  label,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  label: string
  onSave: (reason: string) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom">
        {open ? (
          <PickBody label={label} onSave={onSave} onClose={() => onOpenChange(false)} />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function PickBody({
  label,
  onSave,
  onClose,
}: {
  label: string
  onSave: (reason: string) => void
  onClose: () => void
}) {
  const [reason, setReason] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)

  return (
    <>
      <SheetHeader>
        <SheetTitle>Use {label}</SheetTitle>
        <SheetDescription>
          On a buy-in this reason goes on the line with the offer.
        </SheetDescription>
      </SheetHeader>
      <SheetBody>
        <Field label="Reason" htmlFor="source-reason" layout="stacked" error={error ?? undefined}>
          <Textarea
            id="source-reason"
            autoFocus
            maxLength={200}
            aria-invalid={!!error}
            placeholder="The Cardmarket figure is a week of one seller"
            value={reason}
            onChange={(event) => {
              setReason(event.target.value)
              setError(null)
            }}
            trailingHint={`${reason.length} / 200`}
          />
        </Field>
      </SheetBody>
      <SheetFooter>
        <Button
          type="button"
          trailingArrow
          onClick={() => {
            if (reason.trim().length < 3) {
              setError("Say why this source is the better one.")
              return
            }
            onSave(reason.trim())
            onClose()
          }}
        >
          Use this source
        </Button>
        <Button variant="text" type="button" onClick={onClose}>
          Cancel
        </Button>
      </SheetFooter>
    </>
  )
}

/** The staff-entered UK sold comp: a price, the listing, and when it sold. */
function CompSheet({
  open,
  onOpenChange,
  title,
  pending,
  serverError,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  pending: boolean
  serverError: string | null
  onSave: (values: { price: number; url: string; sold_at: string }) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom">
        {open ? (
          <CompBody
            title={title}
            pending={pending}
            serverError={serverError}
            onSave={onSave}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function CompBody({
  title,
  pending,
  serverError,
  onSave,
  onClose,
}: {
  title: string
  pending: boolean
  serverError: string | null
  onSave: (values: { price: number; url: string; sold_at: string }) => void
  onClose: () => void
}) {
  const [values, setValues] = React.useState<CompFormValues>({
    price: "",
    url: "",
    soldAt: todayForInput(),
  })
  const [errors, setErrors] = React.useState<CompErrors>({})

  function set(key: keyof CompFormValues, value: string) {
    setValues((current) => ({ ...current, [key]: value }))
    setErrors((current) => ({ ...current, [key]: undefined }))
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle>Add UK comp</SheetTitle>
        <SheetDescription>
          {title ? `${title}. ` : ""}A sold price from ebay.co.uk leads every
          other source for 30 days.
        </SheetDescription>
      </SheetHeader>
      <SheetBody>
        <div className="flex flex-col gap-8">
          <Field
            label="Sold for"
            htmlFor="comp-price"
            layout="stacked"
            error={errors.price}
          >
            <Input
              id="comp-price"
              autoFocus
              inputMode="decimal"
              autoComplete="off"
              className="tnum"
              aria-invalid={!!errors.price}
              leadingIcon={
                <span aria-hidden="true" className="text-[18px] leading-none">
                  &pound;
                </span>
              }
              placeholder="0.00"
              value={values.price}
              onChange={(event) => set("price", event.target.value)}
            />
          </Field>
          <Field
            label="Listing"
            htmlFor="comp-url"
            layout="stacked"
            error={errors.url}
          >
            <Input
              id="comp-url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!errors.url}
              placeholder="https://www.ebay.co.uk/itm/..."
              value={values.url}
              onChange={(event) => set("url", event.target.value)}
            />
          </Field>
          <Field
            label="Sold on"
            htmlFor="comp-date"
            layout="stacked"
            error={errors.soldAt}
          >
            <Input
              id="comp-date"
              type="date"
              className="tnum"
              aria-invalid={!!errors.soldAt}
              value={values.soldAt}
              onChange={(event) => set("soldAt", event.target.value)}
            />
          </Field>
        </div>
        {serverError ? (
          <p role="alert" className="mt-8 text-[13px] text-destructive">
            {serverError}
          </p>
        ) : null}
      </SheetBody>
      <SheetFooter>
        <Button
          type="button"
          trailingArrow
          loading={pending}
          onClick={() => {
            const result = validateComp(values)
            if (!result.ok) {
              setErrors(result.errors)
              return
            }
            onSave(result.body)
          }}
        >
          Save comp
        </Button>
        <Button variant="text" type="button" onClick={onClose}>
          Cancel
        </Button>
      </SheetFooter>
    </>
  )
}

export function PriceSources({
  subject,
  onPick,
  picked = null,
  actions = true,
  className,
}: PriceSourcesProps) {
  const settings = usePricingSettings()
  const queryClient = useQueryClient()
  const [compOpen, setCompOpen] = React.useState(false)
  const [pickSource, setPickSource] = React.useState<SourceRowView | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [compError, setCompError] = React.useState<string | null>(null)

  const isCard = subject.kind === "card"
  const query = useQuery(
    isCard
      ? cardPricesQuery(subject.id, subject.finish ?? "", subject.condition ?? "NM")
      : retroPricesQuery(subject.id, subject.finish ?? "")
  )
  const fx = useFx()

  function settle(next: PriceView) {
    // The write routes answer with the recomputed view, so the cache takes it
    // straight away and every other copy of this card on screen refetches.
    queryClient.setQueryData(
      isCard
        ? priceKeys.card(subject.id, subject.finish ?? "", subject.condition ?? "NM")
        : priceKeys.retro(subject.id, subject.finish ?? ""),
      next
    )
    void queryClient.invalidateQueries({
      queryKey: isCard ? priceKeys.cardAll(subject.id) : priceKeys.retroAll(subject.id),
    })
  }

  const refresh = useMutation({
    mutationFn: () =>
      isCard
        ? refreshPrices(subject.id, subject.finish ?? "")
        : refreshRetroPrices(subject.id, subject.finish ?? ""),
    onSuccess: (next) => {
      setError(null)
      settle(next)
    },
    onError: (err) =>
      setError(
        refusalOrFallback(err, "That refresh did not go through. Try again in a moment.")
      ),
  })

  const comp = useMutation({
    mutationFn: (body: UkCompInput) =>
      isCard ? addUkComp(subject.id, body) : addRetroUkComp(subject.id, body),
    onSuccess: (next) => {
      setCompError(null)
      setCompOpen(false)
      settle(next)
    },
    onError: (err) =>
      setCompError(refusalOrFallback(err, "That comp did not save. Check the link and try again.")),
  })

  const priority = isCard ? settings.sourcePriority : settings.retroSourcePriority
  const rows = sourceRows(query.data, priority, {
    gameKey: subject.gameKey,
    haircutPct: settings.ebayHaircutPct,
    fxDate: fx.data?.date ?? null,
  })
  // "Picked" only means something when it is not what the rules chose anyway:
  // a line whose market came from the chosen source is chosen, not overruled.
  const pickedRow =
    picked && picked !== query.data?.chosen?.source
      ? (rows.find((row) => row.source === picked && row.gbp !== null) ?? null)
      : null

  const inUseMarket = pickedRow?.gbp ?? query.data?.chosen?.gbp_market ?? null
  const adjusted =
    inUseMarket === null || !subject.condition
      ? null
      : adjustForCondition(
          inUseMarket,
          subject.condition as CardCondition,
          settings.conditionMultipliers
        )

  return (
    <div className={cn("w-full", className)} data-testid="price-sources">
      {fx.data?.stale ? (
        <p className="mb-4 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground">
          {fxWarning(fx.data.fetched_at)}
        </p>
      ) : null}

      {query.isPending ? (
        <div className="flex flex-col gap-3 py-2" aria-hidden="true">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-3/5" />
        </div>
      ) : (
        // Not "Price sources": a screen-reader label that opens with the word
        // Price also answers to the Price field beside it.
        <ul aria-label="Where the value comes from">
          {rows.map((row) => (
            <SourceRow
              key={row.source}
              row={row}
              inUse={pickedRow ? row.source === pickedRow.source : row.chosen}
              picked={Boolean(pickedRow && row.source === pickedRow.source)}
              onPick={onPick ? () => setPickSource(row) : undefined}
            />
          ))}
        </ul>
      )}

      {/* Only worth saying when the condition actually takes something off.
          Worked out here rather than read off the response, so it follows a
          source a staff member picked over the one the rules chose. */}
      {adjusted !== null && adjusted !== inUseMarket && subject.condition ? (
        <p className="mt-4 text-[13px] leading-[1.45] text-muted-foreground">
          {subject.condition} takes it to{" "}
          <span className="tnum">{formatGBP(adjusted)}</span>.
        </p>
      ) : null}

      {query.isError ? (
        <p className="mt-4 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground">
          {refusalOrFallback(
            query.error,
            "Those prices did not load. Try Refresh, or check the connection."
          )}
        </p>
      ) : null}

      {actions ? (
        <div className="mt-6 flex flex-wrap items-center gap-8">
          <Button
            variant="text"
            type="button"
            loading={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            Refresh
          </Button>
          <Button
            variant="text"
            type="button"
            onClick={() => {
              setCompError(null)
              setCompOpen(true)
            }}
          >
            Add UK comp
          </Button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-4 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}

      <CompSheet
        open={compOpen}
        onOpenChange={(open) => {
          setCompOpen(open)
          if (!open) setCompError(null)
        }}
        title={subject.title ?? ""}
        pending={comp.isPending}
        serverError={compError}
        onSave={(body) =>
          comp.mutate({
            ...body,
            finish: subject.finish ?? "",
            condition: subject.condition ?? "NM",
          })
        }
      />

      <PickSheet
        open={pickSource !== null}
        onOpenChange={(open) => {
          if (!open) setPickSource(null)
        }}
        label={pickSource?.label ?? ""}
        onSave={(reason) => {
          if (pickSource && pickSource.gbp !== null && onPick) {
            onPick({ source: pickSource.source, gbp: pickSource.gbp, reason })
          }
          setPickSource(null)
        }}
      />
    </div>
  )
}
