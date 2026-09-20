import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { MinusIcon, PlusIcon, XIcon } from "lucide-react"
import { formatGBP } from "@gg/shared"
import type { OfferSettings, PricingRule } from "@gg/shared/pricing"

import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Hint, MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ProductImage } from "@/components/product-image"
import { CardSearchField } from "@/features/stock/CardSearchField"
import { MoneyField } from "@/features/tradein/MoneyField"
import { OverrideSheet } from "@/features/tradein/OverrideSheet"
import {
  CARD_CONDITIONS,
  COSMETIC_GRADES,
  LINE_FINISHES,
  RETRO_COMPLETENESS,
  lineOffer,
  type LineKind,
  type TradeLine,
  type Totals,
} from "@/features/tradein/machine"
import { listGames, type CardHit, type GameRecord } from "@/lib/api"

const KINDS: { value: LineKind; label: string }[] = [
  { value: "single", label: "Card" },
  { value: "graded", label: "Graded" },
  { value: "retro", label: "Retro" },
  { value: "sealed", label: "Sealed" },
  { value: "bulk", label: "Bulk lot" },
]

const CARD_KINDS = new Set<LineKind>(["single", "graded"])

function newKey(): string {
  return `line_${Math.random().toString(36).slice(2, 10)}`
}

function platformFor(kind: LineKind): string {
  if (kind === "graded") return "graded_slab"
  if (kind === "retro") return "snes_pal_box"
  if (kind === "sealed") return "etb"
  return "tcg_card"
}

export interface ItemsStepProps {
  lines: TradeLine[]
  rules: PricingRule[]
  settings: OfferSettings
  sums: Totals
  /** True when the server would not hand over any offer bands. */
  rulesMissing: boolean
  onAdd: (line: TradeLine) => void
  onUpdate: (key: string, patch: Partial<TradeLine>) => void
  onRemove: (key: string) => void
  saveError: string | null
}

/**
 * The lines.
 *
 * Every line carries its own market value, because Phase 2 has no live price
 * feed at the counter yet: the field is labelled "Manual" so nobody mistakes
 * a typed figure for a fetched one. The cash and credit offers beside it come
 * from the shared evaluator with the shop's own bands, and an override needs
 * a reason before it will save.
 */
export function ItemsStep({
  lines,
  rules,
  settings,
  sums,
  rulesMissing,
  onAdd,
  onUpdate,
  onRemove,
  saveError,
}: ItemsStepProps) {
  const [kind, setKind] = React.useState<LineKind>("single")
  const [title, setTitle] = React.useState("")
  const [bulkCount, setBulkCount] = React.useState(1)
  const [bulkOffer, setBulkOffer] = React.useState(0)
  const [gameId, setGameId] = React.useState("")
  const [overrideKey, setOverrideKey] = React.useState<string | null>(null)
  const searchRef = React.useRef<HTMLInputElement>(null)

  const { data: games = [] } = useQuery({ queryKey: ["games"], queryFn: listGames })
  const retroGame = games.find((game) => game.key === "retro")
  const defaultGame = games.find((game) => game.key !== "retro") ?? games[0]

  // `trade_in_lines.game` is required by the migration, so a line that has no
  // card to take it from gets the retro game or the shop's first game.
  const gameFor = (forKind: LineKind, chosen?: GameRecord): string => {
    if (forKind === "retro") return retroGame?.id ?? defaultGame?.id ?? ""
    return chosen?.id ?? (gameId || defaultGame?.id || "")
  }

  function addCard(card: CardHit | null) {
    if (!card) return
    onAdd({
      key: newKey(),
      id: undefined,
      kind,
      title: card.name,
      cardId: card.id,
      gameId: card.gameId,
      setName: card.setName,
      number: card.number,
      image: card.image,
      finish: card.finishes[0],
      condition: "NM",
      qty: 1,
      marketPence: card.marketPence ?? 0,
      marketSource: "Manual",
      accepted: true,
    })
    window.setTimeout(() => searchRef.current?.focus(), 0)
  }

  function addFreeText() {
    const clean = title.trim()
    if (!clean) return
    onAdd({
      key: newKey(),
      kind,
      title: clean,
      gameId: gameFor(kind),
      condition: kind === "retro" ? "boxed" : undefined,
      cosmetic: kind === "retro" ? "B" : undefined,
      qty: 1,
      marketPence: 0,
      marketSource: "Manual",
      accepted: true,
    })
    setTitle("")
  }

  function addBulk() {
    onAdd({
      key: newKey(),
      kind: "bulk",
      title: `Bulk lot, ${bulkCount} ${bulkCount === 1 ? "card" : "cards"}`,
      gameId: gameFor("bulk"),
      qty: Math.max(1, bulkCount),
      marketPence: 0,
      marketSource: "Manual",
      bulkOffer,
      accepted: true,
    })
    setBulkCount(1)
    setBulkOffer(0)
  }

  const overridden = lines.find((line) => line.key === overrideKey)
  const overriddenOffer = overridden
    ? lineOffer(overridden, rules, settings)
    : null

  return (
    <div>
      <SectionHeading className="mt-0">What they are selling</SectionHeading>

      <ChipGroup
        aria-label="Line type"
        value={[kind]}
        onValueChange={(next) => {
          if (next[0]) setKind(next[0] as LineKind)
        }}
      >
        {KINDS.map((option) => (
          <Chip key={option.value} value={option.value}>
            {option.label}
          </Chip>
        ))}
      </ChipGroup>

      <div className="mt-8">
        {CARD_KINDS.has(kind) ? (
          <Field label="Set and number" htmlFor="buyin-card" layout="stacked">
            <CardSearchField
              id="buyin-card"
              value={null}
              onChange={addCard}
              inputRef={searchRef}
            />
          </Field>
        ) : kind === "bulk" ? (
          <div className="flex flex-col gap-8 sm:flex-row sm:items-end sm:gap-10">
            <Field
              label="How many cards"
              htmlFor="buyin-bulk-count"
              layout="stacked"
              className="sm:w-40"
            >
              <Input
                id="buyin-bulk-count"
                inputMode="numeric"
                className="tnum"
                value={String(bulkCount)}
                onChange={(event) => {
                  const next = Number(event.target.value.replace(/\D/g, ""))
                  setBulkCount(Number.isFinite(next) && next > 0 ? next : 1)
                }}
              />
            </Field>
            <Field
              label="Flat offer for the lot"
              htmlFor="buyin-bulk-offer"
              layout="stacked"
              className="sm:w-48"
            >
              <MoneyField
                id="buyin-bulk-offer"
                label="Flat offer for the lot"
                value={bulkOffer}
                onChange={setBulkOffer}
              />
            </Field>
            <div className="pb-2">
              <Button variant="text" type="button" onClick={addBulk}>
                Add lot
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-8 sm:flex-row sm:items-end sm:gap-10">
            <Field
              label="Title"
              htmlFor="buyin-title"
              layout="stacked"
              className="sm:flex-1"
            >
              <Input
                id="buyin-title"
                autoComplete="off"
                placeholder={
                  kind === "retro"
                    ? "Mario Kart 64, boxed"
                    : "Surging Sparks Elite Trainer Box"
                }
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return
                  event.preventDefault()
                  addFreeText()
                }}
              />
            </Field>
            {kind === "sealed" && games.length > 0 ? (
              <Field
                label="Game"
                htmlFor="buyin-game"
                layout="stacked"
                className="sm:w-52"
              >
                <Select
                  value={gameId || defaultGame?.id || null}
                  onValueChange={(next) => setGameId(next ?? "")}
                >
                  <SelectTrigger id="buyin-game">
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
              </Field>
            ) : null}
            <div className="pb-2">
              <Button variant="text" type="button" onClick={addFreeText}>
                Add line
              </Button>
            </div>
          </div>
        )}
      </div>

      {rulesMissing ? (
        <p className="mt-8 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground">
          The offer bands are admin only, so this account cannot read them.
          Enter each offer with Override, or ask an admin to open the wizard.
        </p>
      ) : null}

      {/* ---- The lines ------------------------------------------------- */}
      <ul className="mt-12 pb-4" aria-label="Lines on this buy-in">
        {lines.map((line) => {
          const offer = lineOffer(line, rules, settings)
          const isRetro = line.kind === "retro"
          const isBulk = line.kind === "bulk"
          return (
            <li
              key={line.key}
              data-testid="trade-line"
              className="border-b border-hairline-soft py-6 first:border-t first:border-hairline-soft"
            >
              <div className="flex items-start gap-4">
                {!isBulk ? (
                  <ProductImage
                    src={line.image}
                    alt=""
                    platform={platformFor(line.kind)}
                    height={56}
                    className="shrink-0"
                  />
                ) : null}
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] leading-[1.4] text-foreground">
                    {line.title}
                  </p>
                  {line.setName || line.number ? (
                    <p className="mt-1 text-[13px] text-muted-foreground-2">
                      {[line.setName, line.number].filter(Boolean).join(" · ")}
                    </p>
                  ) : null}
                </div>
                <Button
                  variant="ghost-icon"
                  type="button"
                  aria-label={`Remove ${line.title}`}
                  onClick={() => onRemove(line.key)}
                >
                  <XIcon />
                </Button>
              </div>

              {/* A sealed box has no condition and no finish: it is sealed.
                  Cards take NM to DMG plus a finish, retro takes how
                  complete it is plus a cosmetic grade. */}
              {isRetro || CARD_KINDS.has(line.kind) ? (
                <div className="mt-5 flex flex-col gap-5">
                  <ChipGroup
                    aria-label={isRetro ? "Completeness" : "Condition"}
                    value={line.condition ? [line.condition] : []}
                    onValueChange={(next) =>
                      onUpdate(line.key, { condition: next[0] })
                    }
                  >
                    {isRetro
                      ? RETRO_COMPLETENESS.map((option) => (
                          <Chip key={option.value} value={option.value}>
                            {option.label}
                          </Chip>
                        ))
                      : CARD_CONDITIONS.map((option) => (
                          <Chip key={option} value={option}>
                            {option}
                          </Chip>
                        ))}
                  </ChipGroup>

                  {isRetro ? (
                    <ChipGroup
                      aria-label="Cosmetic grade"
                      value={line.cosmetic ? [line.cosmetic] : []}
                      onValueChange={(next) =>
                        onUpdate(line.key, {
                          cosmetic: next[0] as TradeLine["cosmetic"],
                        })
                      }
                    >
                      {COSMETIC_GRADES.map((grade) => (
                        <Chip key={grade} value={grade}>
                          {grade}
                        </Chip>
                      ))}
                    </ChipGroup>
                  ) : (
                    <ChipGroup
                      aria-label="Finish"
                      value={line.finish ? [line.finish] : []}
                      onValueChange={(next) =>
                        onUpdate(line.key, { finish: next[0] })
                      }
                    >
                      {LINE_FINISHES.map((finish) => (
                        <Chip key={finish.value} value={finish.value}>
                          {finish.label}
                        </Chip>
                      ))}
                    </ChipGroup>
                  )}
                </div>
              ) : null}

              <div className="mt-5 flex flex-wrap items-end gap-x-8 gap-y-5">
                {line.kind === "sealed" || isBulk ? (
                  <div>
                    <MicroLabel className="mb-2">
                      {isBulk ? "Cards" : "Quantity"}
                    </MicroLabel>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost-icon"
                        type="button"
                        aria-label="One fewer"
                        disabled={line.qty <= 1}
                        onClick={() =>
                          onUpdate(line.key, { qty: Math.max(1, line.qty - 1) })
                        }
                      >
                        <MinusIcon />
                      </Button>
                      <Input
                        aria-label={`Quantity for ${line.title}`}
                        inputMode="numeric"
                        containerClassName="w-14"
                        className="tnum text-center"
                        value={String(line.qty)}
                        onChange={(event) => {
                          const next = Number(
                            event.target.value.replace(/\D/g, "")
                          )
                          onUpdate(line.key, {
                            qty: Number.isFinite(next) && next > 0 ? next : 1,
                          })
                        }}
                      />
                      <Button
                        variant="ghost-icon"
                        type="button"
                        aria-label="One more"
                        onClick={() => onUpdate(line.key, { qty: line.qty + 1 })}
                      >
                        <PlusIcon />
                      </Button>
                    </div>
                  </div>
                ) : null}

                {!isBulk ? (
                  <div className="w-36">
                    <MicroLabel className="mb-2">Market</MicroLabel>
                    <MoneyField
                      id={`market-${line.key}`}
                      label={`Market value for ${line.title}`}
                      value={line.marketPence}
                      onChange={(pence) =>
                        onUpdate(line.key, { marketPence: pence })
                      }
                    />
                    <Hint className="mt-1 block">Manual</Hint>
                  </div>
                ) : null}

                <div>
                  <MicroLabel className="mb-2">Cash</MicroLabel>
                  <p className="tnum font-mono text-[20px] leading-none text-foreground">
                    {formatGBP(offer.cashTotal)}
                  </p>
                </div>
                <div>
                  <MicroLabel className="mb-2">Credit</MicroLabel>
                  <p className="tnum font-mono text-[20px] leading-none text-foreground">
                    {formatGBP(offer.creditTotal)}
                  </p>
                </div>
                <div className="pb-1">
                  <Button
                    variant="text"
                    type="button"
                    onClick={() => setOverrideKey(line.key)}
                  >
                    Override
                  </Button>
                </div>
              </div>

              {line.overrideReason ? (
                <p className="mt-4 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground">
                  Overridden: {line.overrideReason}
                </p>
              ) : offer.source === "none" ? (
                <p className="mt-4 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground">
                  No band matches this line. Override the offer to price it.
                </p>
              ) : null}
            </li>
          )
        })}
      </ul>

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

      {/* ---- Totals ------------------------------------------------------ */}
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

      <OverrideSheet
        open={overrideKey !== null}
        onOpenChange={(open) => {
          if (!open) setOverrideKey(null)
        }}
        title={overridden?.title ?? ""}
        overridden={Boolean(overridden?.overrideReason)}
        initial={{
          cash: overridden?.overrideCash ?? overriddenOffer?.cash ?? 0,
          credit: overridden?.overrideCredit ?? overriddenOffer?.credit ?? 0,
          reason: overridden?.overrideReason ?? "",
        }}
        onSave={(values) => {
          if (!overrideKey) return
          onUpdate(overrideKey, {
            overrideCash: values.cash,
            overrideCredit: values.credit,
            overrideReason: values.reason,
          })
        }}
        onClear={() => {
          if (!overrideKey) return
          onUpdate(overrideKey, {
            overrideCash: undefined,
            overrideCredit: undefined,
            overrideReason: undefined,
          })
        }}
      />
    </div>
  )
}
