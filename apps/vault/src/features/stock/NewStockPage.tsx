import * as React from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { ArrowLeft, Layers, Minus, PackagePlus, Plus, ScanLine, Search, Sparkles, X } from "lucide-react"
import { displayCode, isValidCode, normaliseCode } from "@gg/shared/sku"

import { cn } from "@/lib/cn"
import { Badge, Button, Card, Chip, IconButton, Input, Money, MoneyInput, PageHeader, Segmented, Skeleton, useToast } from "@/ui"

import { addToPrintList, conditionPrice, createItem, errorText, searchCards, useCard, useLookups, useStockMutation, type CatalogueCard } from "./api"
import { SelectField } from "./components/SelectField"
import { marginPct, suggestedSticker } from "./lib/inventory"
import { ScanSheet } from "./scan/ScanSheet"
import { CONDITIONS, type Condition, type ItemKind } from "./types"

const KINDS: { value: ItemKind; label: string }[] = [
  { value: "sealed", label: "Sealed" },
  { value: "graded", label: "Graded" },
  { value: "retro", label: "Retro" },
  { value: "single", label: "Single card" },
  { value: "accessory", label: "Accessory" },
  { value: "other", label: "Other, comics" },
]

export function NewStockPage({ cardId }: { cardId?: string }) {
  const navigate = useNavigate()
  const toast = useToast()
  const lookups = useLookups()

  const [mode, setMode] = React.useState<"card" | "custom">("card")
  const [pickedId, setPickedId] = React.useState<string | undefined>(cardId)
  const card = useCard(pickedId)

  const [condition, setCondition] = React.useState<Condition>("NM")
  const [qty, setQty] = React.useState(1)
  const [cost, setCost] = React.useState<number | null>(null)
  const [typedPrice, setPrice] = React.useState<number | null>(null)
  const [priceTouched, setPriceTouched] = React.useState(false)
  const [location, setLocation] = React.useState("")
  const [kind, setKind] = React.useState<ItemKind>("sealed")
  const [title, setTitle] = React.useState("")
  const [game, setGame] = React.useState("")
  const [ean, setEan] = React.useState("")
  const [printAfter, setPrintAfter] = React.useState(true)
  const [scanning, setScanning] = React.useState(false)
  const [tried, setTried] = React.useState(false)

  // The market for the chosen condition. NM comes with the card itself.
  const market = useQuery({
    queryKey: ["stock", "card-price", pickedId, condition],
    enabled: Boolean(pickedId) && mode === "card",
    queryFn: () => (condition === "NM" && card.data ? Promise.resolve(card.data.nmPrice) : conditionPrice(pickedId ?? "", condition)),
  })
  const marketPence = mode === "card" ? (market.data ?? null) : null
  const suggestion = suggestedSticker(marketPence)

  // The sticker follows the suggestion until someone types one.
  const price = mode === "card" && !priceTouched ? suggestion : typedPrice

  const create = useStockMutation(async () => {
    const created = await createItem(
      mode === "card" && card.data
        ? {
            kind: "single",
            game: card.data.game,
            card: card.data.id,
            set_code: card.data.setCode,
            number: card.data.number,
            condition,
            qty,
            cost: cost ?? 0,
            price: price ?? 0,
            location,
            market_at_intake: marketPence,
          }
        : {
            kind,
            game,
            title: title.trim(),
            condition: kind === "single" ? condition : undefined,
            qty,
            cost: cost ?? 0,
            price: price ?? 0,
            location,
            ean: ean.trim(),
          }
    )
    if (printAfter && (price ?? 0) > 0) await addToPrintList([{ id: created.id, qty }])
    return created
  })

  const missing =
    mode === "card"
      ? !card.data
        ? "Pick a card first."
        : null
      : !title.trim()
        ? "Give the item a name."
        : !game
          ? "Choose a game or range."
          : null

  const submit = () => {
    setTried(true)
    if (missing) return
    create.mutate(undefined, {
      onSuccess: (created) => {
        toast({ message: `Added ${displayCode(created.sku)}.`, tone: "ok" })
        navigate({ to: "/stock/$id", params: { id: created.sku } })
      },
      onError: (error) => toast({ message: errorText(error, "The item was not saved. Check the fields and try again."), tone: "alert" }),
    })
  }

  const onScan = React.useCallback(
    (value: string) => {
      setScanning(false)
      const code = normaliseCode(value)
      if (isValidCode(code)) {
        toast("That is one of our labels. Opening the item.")
        navigate({ to: "/stock/$id", params: { id: code } })
        return
      }
      setMode("custom")
      setEan(value.trim())
      toast({ message: `Barcode ${value.trim()} added. Name the item to finish.`, tone: "ok" })
    },
    [navigate, toast]
  )

  const margin = price && cost ? marginPct(price, cost) : null

  return (
    <section className="pb-6">
      <Link to="/stock" className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-fg-2 hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden />
        Stock
      </Link>
      <PageHeader
        eyebrow="Inventory"
        title="Add stock"
        actions={
          <IconButton label="Scan a barcode" variant="secondary" size="lg" onClick={() => setScanning(true)}>
            <ScanLine aria-hidden />
          </IconButton>
        }
      >
        Identify it, price it, label it, put it away.
      </PageHeader>

      <Segmented
        label="What are you adding"
        block
        className="mb-4"
        value={mode}
        onChange={setMode}
        options={[
          { value: "card", label: "From a card", icon: <Layers aria-hidden /> },
          { value: "custom", label: "Custom item", icon: <PackagePlus aria-hidden /> },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-4">
          {mode === "card" ? (
            pickedId ? (
              <CardPanel
                card={card.data}
                loading={card.isPending}
                error={card.isError}
                market={marketPence}
                marketLoading={market.isFetching}
                condition={condition}
                onClear={() => {
                  setPickedId(undefined)
                  setPriceTouched(false)
                  navigate({ to: "/stock/new", search: {}, replace: true })
                }}
              />
            ) : (
              <CardSearch onPick={(c) => setPickedId(c.id)} error={tried && missing ? missing : null} />
            )
          ) : (
            <Card className="flex flex-col gap-4">
              <Input
                label="Name"
                placeholder="Evolving Skies Elite Trainer Box"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                error={tried && !title.trim() ? "Give the item a name." : null}
              />
              <div className="grid grid-cols-2 gap-3">
                <SelectField label="Type" value={kind} onChange={(v) => setKind(v as ItemKind)} options={KINDS} />
                <SelectField
                  label="Game or range"
                  value={game}
                  onChange={setGame}
                  placeholder="Choose"
                  options={(lookups.data?.games ?? []).map((g) => ({ value: g.id, label: g.name }))}
                  error={tried && !game ? "Choose one." : null}
                />
              </div>
              <Input
                label="Barcode"
                mono
                inputMode="numeric"
                placeholder="EAN, optional"
                value={ean}
                onChange={(e) => setEan(e.target.value)}
                trailing={
                  <button type="button" onClick={() => setScanning(true)} aria-label="Scan the barcode" className="p-1">
                    <ScanLine className="size-5" aria-hidden />
                  </button>
                }
              />
            </Card>
          )}
        </div>

        <Card className="flex flex-col gap-4">
          {(mode === "card" || kind === "single") && (
            <div className="flex flex-col gap-1.5">
              <span className="label-mono text-fg-2">Condition</span>
              <div role="radiogroup" aria-label="Condition" className="flex gap-1.5">
                {CONDITIONS.map((c) => (
                  <Chip
                    key={c}
                    role="radio"
                    aria-checked={condition === c}
                    selected={condition === c}
                    onClick={() => setCondition(c)}
                    className="h-11 flex-1 justify-center px-0 font-mono"
                  >
                    {c}
                  </Chip>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <span className="label-mono text-fg-2" id="qty-label">
              Quantity
            </span>
            <div className="flex items-center gap-2" role="group" aria-labelledby="qty-label">
              <IconButton label="One fewer" variant="secondary" size="lg" disabled={qty <= 1} onClick={() => setQty((q) => Math.max(1, q - 1))}>
                <Minus aria-hidden />
              </IconButton>
              <input
                aria-labelledby="qty-label"
                inputMode="numeric"
                className="h-12 w-full min-w-0 flex-1 rounded-md border border-line-2 bg-panel-2 text-center font-mono text-xl font-bold tnum outline-none focus:border-volt"
                value={qty}
                onChange={(e) => setQty(Math.max(1, Math.min(9999, Number(e.target.value.replace(/\D/g, "")) || 1)))}
              />
              <IconButton label="One more" variant="secondary" size="lg" onClick={() => setQty((q) => Math.min(9999, q + 1))}>
                <Plus aria-hidden />
              </IconButton>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <MoneyInput label="Cost each" value={cost} onChange={setCost} hint="What we paid" />
            <MoneyInput
              label="Sticker price"
              value={price}
              onChange={(v) => {
                setPriceTouched(true)
                setPrice(v)
              }}
              hint={margin !== null ? `${margin}% margin` : "What it sells for"}
            />
          </div>
          {suggestion !== null && price !== suggestion && (
            <button
              type="button"
              onClick={() => {
                setPrice(suggestion)
                setPriceTouched(false)
              }}
              className="-mt-2 inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-fg-2 hover:text-fg"
            >
              <Sparkles className="size-4 text-pop-text" aria-hidden />
              Use suggested <Money pence={suggestion} size="sm" />
            </button>
          )}

          <SelectField
            label="Location"
            value={location}
            onChange={setLocation}
            placeholder="Not shelved yet"
            options={(lookups.data?.locations ?? []).map((l) => ({ value: l.id, label: l.name }))}
          />

          <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-md border border-line bg-panel-2 px-3.5">
            <input
              type="checkbox"
              checked={printAfter}
              onChange={(e) => setPrintAfter(e.target.checked)}
              className="size-5 accent-[var(--volt)]"
            />
            <span className="text-[15px]">Add to the print list</span>
          </label>

          <Button size="lg" block loading={create.isPending} onClick={submit} icon={<PackagePlus className="size-5" aria-hidden />}>
            Add {qty > 1 ? `${qty} to stock` : "to stock"}
          </Button>
          {tried && missing && (
            <p role="alert" className="-mt-2 text-sm font-medium text-pop-text">
              {missing}
            </p>
          )}
        </Card>
      </div>

      <ScanSheet open={scanning} onClose={() => setScanning(false)} onResult={onScan} />
    </section>
  )
}

function CardPanel({
  card,
  loading,
  error,
  market,
  marketLoading,
  condition,
  onClear,
}: {
  card: CatalogueCard | undefined
  loading: boolean
  error: boolean
  market: number | null
  marketLoading: boolean
  condition: Condition
  onClear: () => void
}) {
  if (loading) return <Skeleton className="h-44 rounded-lg" />
  if (error || !card)
    return (
      <Card>
        <p className="text-fg-2">That card is not in the catalogue. Search for it, or add a custom item.</p>
        <Button variant="secondary" className="mt-3" onClick={onClear}>
          Search instead
        </Button>
      </Card>
    )
  return (
    <Card accent="volt" tilt className="relative flex gap-4 overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute -top-16 -right-16 size-48 rounded-full bg-volt/20 blur-3xl" />
      <div className="relative aspect-[5/7] w-28 shrink-0 overflow-hidden rounded-[8px] border border-line bg-panel-2 shadow-panel">
        {card.image && <img src={card.image} alt="" className="size-full object-cover" />}
      </div>
      <div className="relative flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <h2 className="font-display text-2xl leading-none uppercase tracking-wide">{card.name}</h2>
          <IconButton label="Change card" size="sm" onClick={onClear}>
            <X aria-hidden />
          </IconButton>
        </div>
        <p className="text-sm text-fg-2">
          {card.setName} <span className="font-mono text-fg-3">#{card.number}</span>
        </p>
        <div className="mt-auto pt-3">
          <p className="label-mono text-fg-3">{condition} market, UK first</p>
          {marketLoading ? (
            <Skeleton className="mt-1 h-8 w-28" />
          ) : market !== null ? (
            <Money pence={market} size="lg" tone="volt" tween />
          ) : (
            <Badge tone="warn">No price on file</Badge>
          )}
        </div>
      </div>
    </Card>
  )
}

function CardSearch({ onPick, error }: { onPick: (card: CatalogueCard) => void; error: string | null }) {
  const [q, setQ] = React.useState("")
  const [term, setTerm] = React.useState("")
  React.useEffect(() => {
    const t = setTimeout(() => setTerm(q), 250)
    return () => clearTimeout(t)
  }, [q])
  const results = useQuery({ queryKey: ["stock", "card-search", term], enabled: term.trim().length >= 2, queryFn: () => searchCards(term) })
  return (
    <Card className="flex flex-col gap-3">
      <Input
        label="Find the card"
        placeholder="Charizard ex 199"
        leading={<Search aria-hidden />}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        error={error}
        autoFocus
      />
      {results.isFetching && <Skeleton lines={3} />}
      {results.data && results.data.length === 0 && (
        <p className="text-sm text-fg-2">No card matches that. Check the name and number, or add a custom item.</p>
      )}
      {results.data && results.data.length > 0 && (
        <ul className="-mx-1 flex flex-col">
          {results.data.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onPick(c)}
                className={cn("flex w-full items-center gap-3 rounded-md px-1 py-2 text-left hover:bg-line/60")}
              >
                <span className="aspect-[5/7] w-9 shrink-0 overflow-hidden rounded-[4px] border border-line bg-panel-2">
                  {c.image && <img src={c.image} alt="" className="size-full object-cover" loading="lazy" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{c.name}</span>
                  <span className="block truncate text-sm text-fg-3">
                    {c.setName} #{c.number}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!term && <p className="text-sm text-fg-3">Or open a card from Cards or Scan and press Add to stock.</p>}
    </Card>
  )
}
