import * as React from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Controller, useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { MinusIcon, PlusIcon } from "lucide-react"
import { displayCode, formatGBP, parseDecimalToMinor } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Field, FieldRow } from "@/components/ui/field"
import { BarcodeGlyph, Input } from "@/components/ui/input"
import { Hint, MicroLabel } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { Seal } from "@/components/ui/seal"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { ProductImage } from "@/components/product-image"
import { useCounterDock } from "@/app/counter-dock"
import { registerSearchField } from "@/app/focus-registry"
import { CameraSheet } from "@/features/scan/CameraSheet"
import { CardSearchField } from "@/features/stock/CardSearchField"
import {
  addStockSchema,
  CARD_KINDS,
  COMPLETENESS,
  CONDITIONS,
  finishesFor,
  KINDS,
  SINGLE_QTY_KINDS,
  type AddStockValues,
} from "@/features/stock/schema"
import {
  createItem,
  getCardBySetNumber,
  listGames,
  listLocations,
  queueLabel,
  type CardHit,
  type ItemRecord,
} from "@/lib/api"

export interface AddStockScreenProps {
  /** Prefilled from the command palette or a card search elsewhere. */
  initialSet?: string
  initialNumber?: string
  /** Prefilled from a retail barcode scanned on any screen. */
  initialEan?: string
}

const DEFAULTS: AddStockValues = {
  gameId: "",
  kind: "single",
  cardId: undefined,
  title: "",
  setCode: "",
  number: "",
  finish: undefined,
  condition: undefined,
  completeness: undefined,
  qty: 1,
  cost: "",
  price: "",
  locationId: undefined,
  ean: "",
  notes: "",
}

/** An underlined amount with the pound sign as its leading glyph. */
function MoneyInput({
  id,
  value,
  onChange,
  onBlur,
  invalid,
  inputRef,
}: {
  id: string
  value: string
  onChange: (next: string) => void
  onBlur: () => void
  invalid?: boolean
  inputRef?: React.Ref<HTMLInputElement>
}) {
  return (
    <Input
      id={id}
      ref={inputRef}
      inputMode="decimal"
      autoComplete="off"
      className="tnum"
      aria-invalid={invalid || undefined}
      leadingIcon={
        <span aria-hidden="true" className="text-[18px] leading-none">
          &pound;
        </span>
      }
      placeholder="0.00"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onBlur={() => {
        const pence = parseDecimalToMinor(value)
        // Tidy 4.5 into 4.50 the moment the field is left, so a column of
        // costs lines up without anybody retyping.
        if (pence !== null) onChange(formatGBP(pence).replace("£", ""))
        onBlur()
      }}
    />
  )
}

function Stepper({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string
  value: number
  onChange: (next: number) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost-icon"
        type="button"
        aria-label="One fewer"
        disabled={disabled || value <= 1}
        onClick={() => onChange(Math.max(1, value - 1))}
      >
        <MinusIcon />
      </Button>
      <Input
        id={id}
        inputMode="numeric"
        disabled={disabled}
        containerClassName="w-16"
        className="tnum text-center"
        value={String(value)}
        onChange={(event) => {
          const next = Number(event.target.value.replace(/\D/g, ""))
          onChange(Number.isFinite(next) && next > 0 ? next : 1)
        }}
      />
      <Button
        variant="ghost-icon"
        type="button"
        aria-label="One more"
        disabled={disabled}
        onClick={() => onChange(value + 1)}
      >
        <PlusIcon />
      </Button>
    </div>
  )
}

/**
 * Add stock, from the Nova reference: one Anton line, label-left fields from
 * 900px, and a single black block to finish. The card preview sits beside the
 * form on a desktop and above it on a phone, where the primary button docks
 * to the thumb zone.
 */
export function AddStockScreen({
  initialSet,
  initialNumber,
  initialEan,
}: AddStockScreenProps) {
  const navigate = useNavigate()
  const [card, setCard] = React.useState<CardHit | null>(null)
  const [binderMode, setBinderMode] = React.useState(false)
  const [saved, setSaved] = React.useState<ItemRecord | null>(null)
  const [labelNote, setLabelNote] = React.useState<string | null>(null)
  const [cameraOpen, setCameraOpen] = React.useState(false)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const formRef = React.useRef<HTMLFormElement>(null)
  const dock = useCounterDock()

  const { data: games = [] } = useQuery({ queryKey: ["games"], queryFn: listGames })
  const { data: locations = [] } = useQuery({
    queryKey: ["locations"],
    queryFn: listLocations,
  })

  const form = useForm<AddStockValues>({
    resolver: zodResolver(addStockSchema),
    defaultValues: { ...DEFAULTS, ean: initialEan ?? "" },
    mode: "onSubmit",
  })
  const { control, formState, handleSubmit, reset, setValue } = form
  const errors = formState.errors

  // `useWatch` rather than `watch()`: it subscribes through the control, so
  // the React compiler can memoise around it.
  const kind = useWatch({ control, name: "kind" })
  const gameId = useWatch({ control, name: "gameId" })
  const gameKey = games.find((game) => game.id === gameId)?.key
  const isCard = CARD_KINDS.has(kind)
  const fixedQty = SINGLE_QTY_KINDS.has(kind)

  // `/` focuses this screen's search box rather than opening the palette.
  React.useEffect(() => registerSearchField(searchRef.current), [isCard])

  // A card handed over by the palette arrives as a set and a number.
  const prefilled = React.useRef(false)
  const { data: prefilledCard } = useQuery({
    queryKey: ["card", initialSet, initialNumber],
    queryFn: () => getCardBySetNumber(initialSet!, initialNumber!),
    enabled: Boolean(initialSet && initialNumber),
  })
  React.useEffect(() => {
    if (!prefilledCard || prefilled.current) return
    prefilled.current = true
    setCard(prefilledCard)
    setValue("cardId", prefilledCard.id)
    setValue("gameId", prefilledCard.gameId)
    setValue("setCode", prefilledCard.setCode)
    setValue("number", prefilledCard.number)
  }, [prefilledCard, setValue])

  function chooseCard(next: CardHit | null) {
    setCard(next)
    setValue("cardId", next?.id, { shouldValidate: formState.isSubmitted })
    setValue("setCode", next?.setCode ?? "")
    setValue("number", next?.number ?? "")
    setValue("title", next?.name ?? "")
    if (next) {
      setValue("gameId", next.gameId)
      const allowed: string[] = finishesFor(next.finishes).map((finish) => finish.value)
      const current = form.getValues("finish")
      if (current && !allowed.includes(current)) setValue("finish", undefined)
    }
  }

  const save = useMutation({
    mutationFn: (values: AddStockValues) =>
      createItem({
        kind: values.kind,
        gameId: values.gameId,
        cardId: values.cardId,
        title: values.title || card?.name,
        setCode: values.setCode,
        number: values.number,
        finish: values.finish,
        condition: values.condition,
        completeness: values.completeness,
        qty: Number(values.qty),
        cost: parseDecimalToMinor(values.cost) ?? 0,
        price: parseDecimalToMinor(values.price) ?? 0,
        locationId: values.locationId,
        ean: values.ean,
        notes: values.notes,
      }),
    onSuccess: (item, values) => {
      setLabelNote(null)
      if (binderMode) {
        // Binder mode stays on the form: game, set and location hold, the
        // varying fields clear, and focus goes back to the number field.
        reset({
          ...DEFAULTS,
          kind: values.kind,
          gameId: values.gameId,
          setCode: values.setCode,
          locationId: values.locationId,
        })
        setCard(null)
        setSaved(item)
        window.setTimeout(() => searchRef.current?.focus(), 0)
        return
      }
      setSaved(item)
    },
  })

  const label = useMutation({
    mutationFn: (itemId: string) => queueLabel(itemId, 1),
    onSuccess: () => setLabelNote("Label queued"),
  })

  function startAnother() {
    setSaved(null)
    setLabelNote(null)
    setCard(null)
    reset(DEFAULTS)
  }

  // ---- The success state ------------------------------------------------
  if (saved && !binderMode) {
    return (
      <section className="pt-16 sm:pt-24" aria-live="polite">
        <Seal tick />
        <PageTitle className="mt-10">Saved</PageTitle>
        <p
          data-testid="saved-sku"
          className="tnum mt-4 font-mono text-[28px] leading-none text-foreground"
        >
          {displayCode(saved.sku)}
        </p>
        <p className="mt-4 text-base text-muted-foreground">
          {saved.title || "Item"} is in stock and ready to price up.
        </p>

        {card ? (
          <div className="mt-10">
            <ProductImage src={card.image} alt="" platform="tcg_card" height={160} />
          </div>
        ) : null}

        <div className="mt-14 flex flex-wrap items-center gap-8">
          <Button
            onClick={() => label.mutate(saved.id)}
            loading={label.isPending}
            trailingArrow
          >
            Print label
          </Button>
          <Button variant="text" onClick={startAnother}>
            Add another
          </Button>
          {labelNote ? <Hint aria-live="polite">{labelNote}</Hint> : null}
        </div>
      </section>
    )
  }

  // ---- The form ---------------------------------------------------------
  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Add stock</PageTitle>
      <Lede>Every card, cart and box in one place, priced and findable.</Lede>

      <div className="mt-14 flex flex-col gap-12 min-[900px]:grid min-[900px]:grid-cols-[minmax(0,1fr)_168px] min-[900px]:items-start min-[900px]:gap-16">
        <form
          ref={formRef}
          noValidate
          onSubmit={handleSubmit((values) => save.mutate(values))}
          aria-label="Add stock"
          // Keeps a focused field clear of the docked block on a phone.
          // A control scrolled into view clears the docked group, whatever
          // the browser decides to scroll: the field, the input or the chip.
          className="max-[899px]:[&_*]:scroll-mb-[calc(var(--gg-dock-h,5rem)+1.5rem)]"
        >
          {saved && binderMode ? (
            <p
              aria-live="polite"
              className="mb-10 text-[15px] text-muted-foreground"
            >
              <span className="tnum font-mono text-[13px] text-foreground">
                {displayCode(saved.sku)}
              </span>{" "}
              saved. Binder mode kept the game, set and location.
            </p>
          ) : null}

          <FieldRow>
            <Field label="Game" htmlFor="stock-game" error={errors.gameId?.message}>
              <Controller
                control={control}
                name="gameId"
                render={({ field }) => (
                  <Select
                    value={field.value || null}
                    onValueChange={(next) => field.onChange(next ?? "")}
                  >
                    <SelectTrigger id="stock-game" aria-invalid={!!errors.gameId}>
                      <SelectValue placeholder="Choose a game">
                        {(value: string) =>
                          games.find((game) => game.id === value)?.name ??
                          "Choose a game"
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {games.map((game) => (
                        <SelectItem key={game.id} value={game.id}>
                          {game.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>

            <Field label="Kind" htmlFor="stock-kind">
              <Controller
                control={control}
                name="kind"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={(next) => next && field.onChange(next)}
                  >
                    <SelectTrigger id="stock-kind">
                      <SelectValue>
                        {(value: string) =>
                          KINDS.find((option) => option.value === value)?.label ??
                          "Card single"
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {KINDS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>

            {isCard ? (
              <Field
                label="Set and number"
                htmlFor="stock-card"
                error={errors.cardId?.message}
              >
                <CardSearchField
                  id="stock-card"
                  gameKey={gameKey}
                  value={card}
                  onChange={chooseCard}
                  invalid={!!errors.cardId}
                  inputRef={searchRef}
                />
              </Field>
            ) : (
              <Field label="Title" htmlFor="stock-title" error={errors.title?.message}>
                <Controller
                  control={control}
                  name="title"
                  render={({ field }) => (
                    <Input
                      id="stock-title"
                      ref={searchRef}
                      placeholder="Elite Trainer Box, Surging Sparks"
                      aria-invalid={!!errors.title}
                      value={field.value ?? ""}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                    />
                  )}
                />
              </Field>
            )}

            <Field label="Finish">
              <Controller
                control={control}
                name="finish"
                render={({ field }) => (
                  <ChipGroup
                    aria-label="Finish"
                    value={field.value ? [field.value] : []}
                    onValueChange={(next) => field.onChange(next[0])}
                    className="py-1"
                  >
                    {finishesFor(card?.finishes).map((finish) => (
                      <Chip key={finish.value} value={finish.value}>
                        {finish.label}
                      </Chip>
                    ))}
                  </ChipGroup>
                )}
              />
            </Field>

            {kind === "retro" ? (
              <Field label="Completeness" error={errors.completeness?.message}>
                <Controller
                  control={control}
                  name="completeness"
                  render={({ field }) => (
                    <ChipGroup
                      aria-label="Completeness"
                      value={field.value ? [field.value] : []}
                      onValueChange={(next) => field.onChange(next[0])}
                      className="py-1"
                    >
                      {COMPLETENESS.map((option) => (
                        <Chip key={option.value} value={option.value}>
                          {option.label}
                        </Chip>
                      ))}
                    </ChipGroup>
                  )}
                />
              </Field>
            ) : (
              <Field label="Condition" error={errors.condition?.message}>
                <Controller
                  control={control}
                  name="condition"
                  render={({ field }) => (
                    <ChipGroup
                      aria-label="Condition"
                      value={field.value ? [field.value] : []}
                      onValueChange={(next) => field.onChange(next[0])}
                      className="py-1"
                    >
                      {CONDITIONS.map((option) => (
                        <Chip key={option.value} value={option.value}>
                          {option.label}
                        </Chip>
                      ))}
                    </ChipGroup>
                  )}
                />
              </Field>
            )}

            <Field
              label="Quantity"
              htmlFor="stock-qty"
              error={errors.qty?.message}
            >
              <Controller
                control={control}
                name="qty"
                render={({ field }) => (
                  <Stepper
                    id="stock-qty"
                    value={Number(field.value) || 1}
                    onChange={field.onChange}
                    disabled={fixedQty}
                  />
                )}
              />
            </Field>

            <Field label="Cost" htmlFor="stock-cost" error={errors.cost?.message}>
              <Controller
                control={control}
                name="cost"
                render={({ field }) => (
                  <MoneyInput
                    id="stock-cost"
                    value={field.value ?? ""}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    invalid={!!errors.cost}
                  />
                )}
              />
            </Field>

            <Field label="Price" htmlFor="stock-price" error={errors.price?.message}>
              <Controller
                control={control}
                name="price"
                render={({ field }) => (
                  <MoneyInput
                    id="stock-price"
                    value={field.value ?? ""}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    invalid={!!errors.price}
                  />
                )}
              />
            </Field>

            <Field label="Location" htmlFor="stock-location">
              <Controller
                control={control}
                name="locationId"
                render={({ field }) => (
                  <Select
                    value={field.value || null}
                    onValueChange={(next) => field.onChange(next ?? undefined)}
                  >
                    <SelectTrigger id="stock-location">
                      <SelectValue placeholder="Where it will sit">
                        {(value: string) =>
                          locations.find((location) => location.id === value)?.name ??
                          "Where it will sit"
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
                )}
              />
            </Field>

            {kind === "sealed" || kind === "accessory" ? (
              <Field label="EAN" htmlFor="stock-ean" error={errors.ean?.message}>
                <Controller
                  control={control}
                  name="ean"
                  render={({ field }) => (
                    <Input
                      id="stock-ean"
                      inputMode="numeric"
                      autoComplete="off"
                      className="tnum"
                      aria-invalid={!!errors.ean}
                      leadingIcon={<BarcodeGlyph />}
                      placeholder="Scan the barcode"
                      trailingHint={
                        <button
                          type="button"
                          onClick={() => setCameraOpen(true)}
                          className="font-mono text-[11px] font-bold tracking-[0.16em] text-foreground uppercase underline-offset-4 outline-none hover:underline"
                        >
                          Use camera
                        </button>
                      }
                      value={field.value ?? ""}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                    />
                  )}
                />
              </Field>
            ) : null}

            <Field label="Notes" htmlFor="stock-notes" error={errors.notes?.message}>
              <Controller
                control={control}
                name="notes"
                render={({ field }) => (
                  <Textarea
                    id="stock-notes"
                    maxLength={200}
                    placeholder="Anything the next person needs to know"
                    aria-invalid={!!errors.notes}
                    value={field.value ?? ""}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    trailingHint={`${(field.value ?? "").length} / 200`}
                  />
                )}
              />
            </Field>

            <Field label="Binder mode">
              <div className="flex min-h-10 items-center gap-4 pt-1 pb-2">
                <Switch
                  checked={binderMode}
                  onCheckedChange={setBinderMode}
                  aria-label="Binder mode: keep game, set and location after a save"
                />
                <span className="text-[15px] text-muted-foreground">
                  Keeps the game, set and location after a save
                </span>
              </div>
            </Field>
          </FieldRow>

          {save.isError ? (
            <p role="alert" className="mt-10 text-[13px] text-destructive">
              That did not save. Check the connection and press save again.
            </p>
          ) : null}

          {/* From 900px the block sits with the form; below it docks to the
              thumb zone above the counter bar. */}
          <div className="mt-14 hidden flex-wrap items-center gap-8 min-[900px]:flex">
            <Button type="submit" trailingArrow loading={save.isPending}>
              Save item
            </Button>
            <Button
              variant="text"
              type="button"
              onClick={() => void navigate({ to: "/counter/stock" })}
            >
              Cancel
            </Button>
          </div>

          <div className="mt-14 flex items-center justify-center min-[900px]:hidden">
            <Button
              variant="text"
              type="button"
              onClick={() => void navigate({ to: "/counter/stock" })}
            >
              Cancel
            </Button>
          </div>

        </form>

        {/* Below 900px the one primary action docks into the shell's thumb
            zone, directly on top of the tab bar. It lives outside the form in
            the DOM, so it asks the form to submit itself. */}
        {dock
          ? createPortal(
              <div className="border-t border-hairline-soft bg-background px-5 py-3">
                <Button
                  type="button"
                  trailingArrow
                  loading={save.isPending}
                  className="w-full"
                  onClick={() => formRef.current?.requestSubmit()}
                >
                  Save item
                </Button>
              </div>,
              dock
            )
          : null}

        {/* Beside the form on a desktop, above it on a phone. A phone has no
            room to hold an empty frame open, so it appears with the card. */}
        <aside
          data-testid="card-preview"
          aria-label="Chosen card"
          className={
            card
              ? "max-[899px]:order-first"
              : "max-[899px]:hidden max-[899px]:order-first"
          }
        >
          <MicroLabel className="mb-3">Preview</MicroLabel>
          {card ? (
            <>
              <ProductImage src={card.image} alt="" platform="tcg_card" height={120} />
              <p className="mt-3 text-[13px] leading-[1.45] text-muted-foreground">
                {card.name}
                <br />
                {card.setName} &middot; {card.number}
              </p>
            </>
          ) : (
            <p className="text-[13px] leading-[1.45] text-muted-foreground-2">
              Choose a card and its art appears here.
            </p>
          )}
        </aside>
      </div>

      <CameraSheet
        open={cameraOpen}
        onOpenChange={setCameraOpen}
        onResult={(value) =>
          setValue("ean", value.replace(/\D/g, ""), { shouldValidate: true })
        }
      />
    </section>
  )
}
