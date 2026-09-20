/**
 * The item page: one thing, everything known about it, and the four things
 * staff do with it at the counter.
 *
 * The picture is the subject, large and centred in whitespace, exactly as the
 * Atlas reference gives its one field the page. Everything else is a hairline
 * row under it.
 */
import * as React from "react"
import { createPortal } from "react-dom"
import { Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  adjustForCondition,
  displayCode,
  formatGBP,
  parseDecimalToMinor,
  type CardCondition,
} from "@gg/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Hint, MicroLabel } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
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
import { Skeleton } from "@/components/ui/skeleton"
import { ProductImage } from "@/components/product-image"
import { useCounterDock } from "@/app/counter-dock"
import { CustomerSearchSheet } from "@/features/sell/CustomerSearchSheet"
import { MoneyInput } from "@/features/sell/money-input"
import { penceToField } from "@/features/sell/money"
import { addItemToBasket } from "@/features/sell/basket-store"
import { PriceSources } from "@/features/pricing"
// The hold line says the time the way the want-list notification says it
// ("Held for you until 22 Sep, 14:00"), so the counter and the customer's
// email cannot read differently.
import { formatDateTime as holdTime } from "@/features/quotes/format"
import { holdHasEnded } from "@/features/quotes/filters"
import { suggestedSellPrice } from "@/features/pricing/suggest"
import { refusalOrFallback } from "@/lib/api/refusal"
import {
  getItem,
  listGames,
  listLocations,
  queueLabels,
  reserveItem,
  updateItem,
  writeOffItem,
} from "@/lib/api"
import { useCardPrices, usePricingSettings, useRetroPrices } from "@/lib/api/prices"
import { useVaultConfig } from "@/lib/api/config"
import type { ItemDetail, ItemStatus } from "@/lib/api/types"

const STATUS_LABELS: Record<ItemStatus, string> = {
  in_stock: "In stock",
  reserved: "Reserved",
  listed_ebay: "Listed on eBay",
  sold: "Sold",
  returned: "Returned",
  written_off: "Written off",
}

/** See the same constant on the Sell screen: a blocked block stays legible. */
const BLOCKED =
  "disabled:opacity-100 disabled:bg-surface-3 disabled:text-muted-foreground"

const KIND_LABELS: Record<ItemDetail["kind"], string> = {
  single: "Card single",
  graded: "Graded card",
  retro: "Retro game",
  sealed: "Sealed product",
  accessory: "Accessory",
  other: "Other",
}

/** "holo" reads as "Holo" beside a label, not as a shout. */
function sentence(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function when(iso?: string | null): string {
  if (!iso) return ""
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-12 items-baseline justify-between gap-6 border-b border-hairline-soft py-3">
      <MicroLabel>{label}</MicroLabel>
      <span className="min-w-0 text-right text-[15px] text-foreground">
        {children}
      </span>
    </div>
  )
}

/**
 * The price form. Like every sheet here it lives inside `SheetContent`, which
 * Base UI mounts only while the sheet is open, so it starts from the item's
 * current price each time without an effect reaching in to reset it.
 */
function PriceForm({
  item,
  market,
  suggested,
  pending,
  onSave,
  onCancel,
}: {
  item: ItemDetail
  /** The condition-adjusted market from the price routes, or null. */
  market: number | null
  suggested: number | null
  pending: boolean
  onSave: (pence: number) => void
  onCancel: () => void
}) {
  const [value, setValue] = React.useState(() => penceToField(item.price ?? 0))
  const [error, setError] = React.useState<string | null>(null)

  return (
    <>
      <SheetBody>
        <Field layout="stacked" label="Sell price" htmlFor="item-price">
          <MoneyInput
            id="item-price"
            autoFocus
            value={value}
            onChange={(next) => {
              setValue(next)
              setError(null)
            }}
            invalid={Boolean(error)}
          />
        </Field>
        <FieldError>{error}</FieldError>
        {suggested !== null ? (
          <div className="mt-6 flex flex-wrap items-center gap-6">
            <Hint>
              Market {formatGBP(market ?? 0)}, suggested {formatGBP(suggested)}
            </Hint>
            <Button variant="text" onClick={() => setValue(penceToField(suggested))}>
              Use suggested
            </Button>
          </div>
        ) : null}
      </SheetBody>
      <SheetFooter>
        <Button
          loading={pending}
          trailingArrow
          onClick={() => {
            const pence = parseDecimalToMinor(value)
            if (pence === null || pence < 0) {
              setError("Enter the price in pounds and pence, for example 12.50.")
              return
            }
            onSave(pence)
          }}
        >
          Save price
        </Button>
        <Button variant="text" onClick={onCancel}>
          Cancel
        </Button>
      </SheetFooter>
    </>
  )
}

function PriceSheet({
  open,
  onOpenChange,
  item,
  market,
  suggested,
  pending,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  item: ItemDetail
  market: number | null
  suggested: number | null
  pending: boolean
  onSave: (pence: number) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
        <SheetHeader>
          <SheetTitle>Price</SheetTitle>
          <SheetDescription>{item.title || displayCode(item.sku)}</SheetDescription>
        </SheetHeader>
        <PriceForm
          item={item}
          market={market}
          suggested={suggested}
          pending={pending}
          onSave={onSave}
          onCancel={() => onOpenChange(false)}
        />
      </SheetContent>
    </Sheet>
  )
}

function WriteOffForm({
  pending,
  onConfirm,
  onCancel,
}: {
  pending: boolean
  onConfirm: (reason: string) => void
  onCancel: () => void
}) {
  const [reason, setReason] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)

  return (
    <>
      <SheetBody>
        <Field layout="stacked" label="Reason" htmlFor="write-off-reason">
          <Input
            id="write-off-reason"
            autoFocus
            value={reason}
            maxLength={200}
            placeholder="Damaged in the case, lost in transit"
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              setReason(event.target.value)
              setError(null)
            }}
          />
        </Field>
        <FieldError>{error}</FieldError>
      </SheetBody>
      <SheetFooter>
        <Button
          variant="text-destructive"
          loading={pending}
          onClick={() => {
            if (!reason.trim()) {
              setError("Say why it is going, so the stock book reads straight.")
              return
            }
            onConfirm(reason.trim())
          }}
        >
          Write it off
        </Button>
        <Button variant="text" onClick={onCancel}>
          Cancel
        </Button>
      </SheetFooter>
    </>
  )
}

function WriteOffSheet({
  open,
  onOpenChange,
  pending,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pending: boolean
  onConfirm: (reason: string) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
        <SheetHeader>
          <SheetTitle>Write off</SheetTitle>
          <SheetDescription>
            It leaves stock and stays on the record with your reason.
          </SheetDescription>
        </SheetHeader>
        <WriteOffForm
          pending={pending}
          onConfirm={onConfirm}
          onCancel={() => onOpenChange(false)}
        />
      </SheetContent>
    </Sheet>
  )
}

export function ItemPage({ sku }: { sku: string }) {
  const navigate = useNavigate()
  const dock = useCounterDock()
  const [priceOpen, setPriceOpen] = React.useState(false)
  const [reserveOpen, setReserveOpen] = React.useState(false)
  const [writeOffOpen, setWriteOffOpen] = React.useState(false)
  const [note, setNote] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const { data: item, isPending, refetch } = useQuery({
    queryKey: ["item", sku],
    queryFn: () => getItem(sku),
  })
  const { data: locations = [] } = useQuery({
    queryKey: ["locations"],
    queryFn: listLocations,
    staleTime: 5 * 60_000,
  })
  const { data: games = [] } = useQuery({
    queryKey: ["games"],
    queryFn: listGames,
    staleTime: 5 * 60_000,
  })
  const queryClient = useQueryClient()

  // ---- What it is worth now --------------------------------------------
  // A card prices by finish and condition, a retro title by how complete it
  // is; anything else (sealed, an accessory) has no catalogue row to price
  // against and shows no market section at all.
  const pricing = usePricingSettings()
  // `settings.holds.hours` is the want-list hold's one home, so the Hold
  // button here reads the same figure rather than a second copy of 48.
  const { data: config } = useVaultConfig()
  const holdHours = config?.settings.holds?.hours ?? 48
  const cardPrices = useCardPrices(item?.card, item?.finish ?? "", item?.condition || "NM")
  const retroPrices = useRetroPrices(item?.retro_title, item?.completeness ?? "")
  const priced = item?.card ? cardPrices.data : retroPrices.data
  // A price on its way is not "no price": the line only says so once the
  // route has actually answered.
  const pricesPending = item?.card ? cardPrices.isPending : retroPrices.isPending
  const market = priced?.chosen?.gbp_market ?? null
  const adjustedMarket =
    market === null
      ? null
      : item?.condition
        ? adjustForCondition(
            market,
            item.condition as CardCondition,
            pricing.conditionMultipliers
          )
        : market
  const suggested = suggestedSellPrice(adjustedMarket, pricing)

  /** Anything that changes this item changes the stock list behind it. */
  function settle() {
    void refetch()
    void queryClient.invalidateQueries({ queryKey: ["items"] })
  }

  function onFailure(fallback: string) {
    return (err: unknown) => setError(refusalOrFallback(err, fallback))
  }

  const save = useMutation({
    mutationFn: (patch: { price?: number; locationId?: string }) =>
      updateItem(item?.id ?? "", patch),
    onSuccess: () => {
      setPriceOpen(false)
      setError(null)
      setNote("Saved")
      settle()
    },
    onError: onFailure("That did not save. Check the connection and try again."),
  })

  const reserve = useMutation({
    mutationFn: (customerId: string) => reserveItem(item?.id ?? "", customerId, holdHours),
    onSuccess: (updated) => {
      setError(null)
      setNote(
        `Held for ${updated.reservedForName ?? "the customer"} for ${holdHours} hours`
      )
      settle()
    },
    onError: onFailure("That reservation did not stick. Try again."),
  })

  const label = useMutation({
    mutationFn: () => queueLabels([item?.id ?? ""]),
    onSuccess: () => {
      setError(null)
      setNote("Label queued")
      void queryClient.invalidateQueries({ queryKey: ["label-jobs-list"] })
    },
    onError: onFailure("That label could not be queued. Try again."),
  })

  const writeOff = useMutation({
    mutationFn: (reason: string) => writeOffItem(item?.id ?? "", reason),
    onSuccess: () => {
      setWriteOffOpen(false)
      setError(null)
      setNote("Written off")
      settle()
    },
    onError: onFailure("That write-off did not save. Try again."),
  })

  if (isPending) {
    return (
      <section className="pt-16 sm:pt-24">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="mt-6 h-4 w-72" />
        <Skeleton className="mx-auto mt-14 h-[280px] w-[200px]" />
      </section>
    )
  }

  if (!item) {
    return (
      <section className="pt-16 sm:pt-24">
        <PageTitle>Not in stock</PageTitle>
        <Lede>
          Nothing here carries {displayCode(sku)}. Check the label, or search the
          stock list.
        </Lede>
        <div className="mt-10">
          <Button render={<Link to="/counter/stock" />} trailingArrow>
            Stock list
          </Button>
        </div>
      </section>
    )
  }

  const sellable = item.status === "in_stock" || item.status === "reserved"
  const holdEnded = holdHasEnded(item.reservedUntil)

  const sellAction = (
    <Button
      className={`w-full min-[900px]:w-auto ${BLOCKED}`}
      trailingArrow
      disabled={!sellable}
      onClick={() => {
        addItemToBasket(item)
        void navigate({ to: "/counter/sell" })
      }}
    >
      Sell
    </Button>
  )

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>{item.title || "Item"}</PageTitle>
      <Lede>
        {[item.set_code?.toUpperCase(), item.number, item.gameName]
          .filter(Boolean)
          .join(" · ") || "In the counter's stock."}
      </Lede>

      <div className="mt-14 flex justify-center py-6">
        <ProductImage
          src={item.image}
          alt={item.title || "Item"}
          platform={item.platform}
          height={420}
          priority
        />
      </div>

      <div className="mt-12 flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
        <span className="flex flex-col gap-2">
          <MicroLabel>Price</MicroLabel>
          <span
            data-testid="item-price"
            className="tnum font-display text-[28px] leading-none tracking-[0.01em] text-foreground"
          >
            {formatGBP(item.price ?? 0)}
          </span>
        </span>
        <span className="flex items-center gap-8">
          <Button variant="text" onClick={() => setPriceOpen(true)}>
            Edit
          </Button>
          <Badge variant="outline" data-testid="item-status">
            {STATUS_LABELS[item.status ?? "in_stock"]}
          </Badge>
        </span>
      </div>

      {/* The hold, in one line under the status: who it is for and until
          when, or that it has run out. The release cron puts a lapsed hold
          back within fifteen minutes, so the item can still read "reserved"
          here for a few minutes after the time has passed; saying "Hold
          ended" is honest about what the shelf actually holds. */}
      {item.status === "reserved" && item.reservedForName ? (
        <p data-testid="item-hold" className="mt-4 text-[15px] leading-[1.5] text-muted-foreground">
          {holdEnded ? (
            "Hold ended"
          ) : (
            <>
              Held for{" "}
              {item.reservedForCode ? (
                <Link
                  to="/counter/customers/$code"
                  params={{ code: item.reservedForCode }}
                  className="text-foreground underline-offset-4 outline-none hover:underline"
                >
                  {item.reservedForName}
                </Link>
              ) : (
                <span className="text-foreground">{item.reservedForName}</span>
              )}
              {item.reservedUntil ? ` until ${holdTime(item.reservedUntil)}` : ""}
            </>
          )}
        </p>
      ) : null}

      <div className="mt-16">
        <MicroLabel tone="ink" className="mb-5">
          Details
        </MicroLabel>
        <Row label="Code">
          <span data-testid="item-sku" className="tnum font-mono text-[13px]">
            {displayCode(item.sku)}
          </span>
        </Row>
        {item.condition ? <Row label="Condition">{item.condition}</Row> : null}
        {item.finish ? <Row label="Finish">{sentence(item.finish)}</Row> : null}
        <Row label="Kind">{KIND_LABELS[item.kind]}</Row>
        <Row label="Cost">
          <span className="tnum">{formatGBP(item.cost ?? 0)}</span>
        </Row>
        <Row label="Market at intake">
          <span className="tnum">
            {item.market_at_intake ? formatGBP(item.market_at_intake) : "Not recorded"}
          </span>
        </Row>
        <Row label="Quantity">
          <span className="tnum">{item.qty ?? 1}</span>
        </Row>
        <div className="flex min-h-12 items-center justify-between gap-6 border-b border-hairline-soft py-3">
          <MicroLabel>Location</MicroLabel>
          <div className="w-[220px]">
            <Select
              value={item.location || null}
              onValueChange={(next) =>
                save.mutate({ locationId: (next as string | null) ?? "" })
              }
            >
              <SelectTrigger aria-label="Location">
                <SelectValue placeholder="Not placed yet">
                  {(value: string) =>
                    locations.find((location) => location.id === value)?.name ??
                    "Not placed yet"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {locations.map((location) => (
                  <SelectItem key={location.id} value={location.id}>
                    {location.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {/* The hold is said once, in the line under the status, where it
            can carry a link to the customer. A second row here said the
            same thing again, further down. */}
      </div>

      {item.card || item.retro_title ? (
        <section className="mt-16" aria-label="Market">
          <MicroLabel tone="ink" className="mb-5">
            Market
          </MicroLabel>
          <PriceSources
            subject={
              item.card
                ? {
                    kind: "card",
                    id: item.card,
                    finish: item.finish ?? "",
                    condition: item.condition || "NM",
                    gameKey: games.find((game) => game.id === item.game)?.key,
                    title: item.title ?? "",
                  }
                : {
                    kind: "retro",
                    id: item.retro_title as string,
                    finish: item.completeness ?? "",
                    title: item.title ?? "",
                  }
            }
          />
          {suggested !== null ? (
            <div className="mt-8 flex flex-wrap items-baseline gap-x-10 gap-y-4">
              <span className="flex items-baseline gap-3">
                <MicroLabel>Suggested</MicroLabel>
                <span
                  data-testid="item-suggested"
                  className="tnum text-[20px] leading-none font-medium text-foreground"
                >
                  {formatGBP(suggested)}
                </span>
              </span>
              <Button
                variant="text"
                type="button"
                loading={save.isPending}
                onClick={() => save.mutate({ price: suggested })}
              >
                Reprice to market
              </Button>
            </div>
          ) : pricesPending ? null : (
            <p className="mt-8 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground">
              No source has a value for this one yet. Refresh, or add a UK comp.
            </p>
          )}
        </section>
      ) : null}

      <div className="mt-16">
        <MicroLabel tone="ink" className="mb-5">
          Provenance
        </MicroLabel>
        {item.tradeInNumber ? (
          <>
            <Row label="Bought in on">
              <span className="tnum font-mono text-[13px]">{item.tradeInNumber}</span>
            </Row>
            <Row label="Seller">
              {item.sellerCode ? (
                <Link
                  to="/counter/customers/$code"
                  params={{ code: item.sellerCode }}
                  className="underline-offset-4 hover:underline"
                >
                  {item.sellerName ?? displayCode(item.sellerCode)}
                </Link>
              ) : (
                (item.sellerName ?? "Not recorded")
              )}
            </Row>
          </>
        ) : (
          <Row label="Source">
            {item.supplier_ref || (item.source === "opening_stock" ? "Opening stock" : "Supplier")}
          </Row>
        )}
        {item.acquired_at ? <Row label="Acquired">{when(item.acquired_at)}</Row> : null}
      </div>

      {note || error ? (
        <p
          aria-live="polite"
          className={
            error
              ? "mt-10 text-[13px] text-destructive"
              : "mt-10 text-[13px] text-muted-foreground"
          }
        >
          {error ?? note}
        </p>
      ) : null}

      <div className="mt-14 hidden flex-wrap items-center gap-10 min-[900px]:flex">
        {sellAction}
        <Button variant="text" onClick={() => setReserveOpen(true)} disabled={!sellable}>
          Reserve
        </Button>
        <Button
          variant="text"
          loading={label.isPending}
          onClick={() => label.mutate()}
        >
          Print label
        </Button>
        <Button
          variant="text-destructive"
          onClick={() => setWriteOffOpen(true)}
          disabled={item.status === "written_off"}
        >
          Write off
        </Button>
      </div>

      <div className="mt-14 flex flex-wrap items-center gap-10 min-[900px]:hidden">
        <Button variant="text" onClick={() => setReserveOpen(true)} disabled={!sellable}>
          Reserve
        </Button>
        <Button
          variant="text"
          loading={label.isPending}
          onClick={() => label.mutate()}
        >
          Print label
        </Button>
        <Button
          variant="text-destructive"
          onClick={() => setWriteOffOpen(true)}
          disabled={item.status === "written_off"}
        >
          Write off
        </Button>
      </div>

      <div className="mt-24">
        <MicroLabel tone="ink" className="mb-5">
          History
        </MicroLabel>
        {item.history.length === 0 ? (
          <p className="text-[15px] text-muted-foreground-2">
            Nothing has happened to this one yet.
          </p>
        ) : (
          <ul>
            {item.history.map((event) => (
              <li
                key={`${event.kind}-${event.at}`}
                className="flex min-h-12 items-center gap-4 border-b border-hairline-soft py-3 first:border-t"
              >
                <span className="tnum shrink-0 font-mono text-[13px] text-muted-foreground-2">
                  {when(event.at)}
                </span>
                <span className="min-w-0 flex-1 text-[15px] text-foreground">
                  {event.detail}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {dock
        ? createPortal(
            <div className="border-t border-hairline-soft bg-background px-5 py-3 min-[900px]:hidden">
              {sellAction}
            </div>,
            dock
          )
        : null}

      <PriceSheet
        open={priceOpen}
        onOpenChange={setPriceOpen}
        item={item}
        market={adjustedMarket}
        suggested={suggested}
        pending={save.isPending}
        onSave={(price) => save.mutate({ price })}
      />

      <CustomerSearchSheet
        open={reserveOpen}
        onOpenChange={setReserveOpen}
        title="Reserve"
        description={`Held for ${holdHours} hours for the customer you choose.`}
        onChoose={(customer) => reserve.mutate(customer.id)}
      />

      <WriteOffSheet
        open={writeOffOpen}
        onOpenChange={setWriteOffOpen}
        pending={writeOff.isPending}
        onConfirm={(reason) => writeOff.mutate(reason)}
      />
    </section>
  )
}
