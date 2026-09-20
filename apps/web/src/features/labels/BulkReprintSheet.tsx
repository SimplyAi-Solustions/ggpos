/**
 * Bulk reprint: three ways to put a run of labels back in the queue.
 *
 * A buy-in that has just been priced up, a range of dates a shelf was filled
 * on, or a handful of labels scanned off the items themselves. The counter
 * resolves a buy-in number and a run of codes into ids, because the route
 * takes ids; everything the server refuses comes back in its own words.
 */
import * as React from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { displayCode } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Field, FieldError } from "@/components/ui/field"
import { BarcodeGlyph, Input } from "@/components/ui/input"
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
import { Textarea } from "@/components/ui/textarea"
import {
  bulkCodes,
  bulkProblem,
  bulkSelector,
  emptyBulkForm,
  queueOutcome,
  tradeInNumber,
  type BulkForm,
  type BulkMode,
} from "@/features/labels/bulk"
import { getItem, listGames, listLocations } from "@/lib/api"
import { findTradeInByNumber, queueLabelBatch } from "@/lib/api/label-queue"
import { refusalOrFallback } from "@/lib/api/refusal"
import type { ItemKind } from "@/lib/api/types"

const MODES: { value: BulkMode; label: string }[] = [
  { value: "trade_in", label: "Buy-in" },
  { value: "dates", label: "Dates" },
  { value: "codes", label: "Codes" },
]

const KINDS: { value: ItemKind; label: string }[] = [
  { value: "single", label: "Single" },
  { value: "graded", label: "Graded" },
  { value: "retro", label: "Retro" },
  { value: "sealed", label: "Sealed" },
  { value: "accessory", label: "Accessory" },
  { value: "other", label: "Other" },
]

export interface BulkReprintSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The queue list re-reads itself once labels have been added to it. */
  onQueued: () => void
}

function Form({
  onQueued,
  onDone,
}: {
  onQueued: () => void
  onDone: () => void
}) {
  const [form, setForm] = React.useState<BulkForm>(emptyBulkForm)
  const [problem, setProblem] = React.useState<string | null>(null)
  const [outcome, setOutcome] = React.useState<string | null>(null)

  const set = (patch: Partial<BulkForm>) => {
    setProblem(null)
    setOutcome(null)
    setForm((current) => ({ ...current, ...patch }))
  }

  const { data: locations = [] } = useQuery({
    queryKey: ["locations"],
    queryFn: listLocations,
    staleTime: 5 * 60_000,
    enabled: form.mode === "dates",
  })
  const { data: games = [] } = useQuery({
    queryKey: ["games"],
    queryFn: listGames,
    staleTime: 5 * 60_000,
    enabled: form.mode === "dates",
  })

  const queue = useMutation({
    mutationFn: async () => {
      if (form.mode === "trade_in") {
        const id = await findTradeInByNumber(tradeInNumber(form))
        if (!id) {
          throw new Error(
            `${tradeInNumber(form)} is not a buy-in we have. Check the number on the receipt.`
          )
        }
        return queueLabelBatch(bulkSelector(form, { tradeInId: id }))
      }

      if (form.mode === "codes") {
        const itemIds: string[] = []
        for (const code of bulkCodes(form)) {
          const item = await getItem(code)
          if (!item) throw new Error(`${displayCode(code)} is not a code we hold.`)
          itemIds.push(item.id)
        }
        return queueLabelBatch(bulkSelector(form, { itemIds }))
      }

      return queueLabelBatch(bulkSelector(form))
    },
    onSuccess: (result) => {
      setOutcome(queueOutcome(result))
      onQueued()
    },
    onError: (error) =>
      setProblem(
        refusalOrFallback(error, "Those labels could not be queued. Try again.")
      ),
  })

  function submit() {
    const wrong = bulkProblem(form)
    if (wrong) {
      setProblem(wrong)
      return
    }
    queue.mutate()
  }

  return (
    <>
      <SheetBody>
        <ChipGroup
          aria-label="How to choose the labels"
          value={[form.mode]}
          onValueChange={(next: string[]) => {
            const mode = next[0] as BulkMode | undefined
            if (mode) set({ mode })
          }}
        >
          {MODES.map((mode) => (
            <Chip key={mode.value} value={mode.value}>
              {mode.label}
            </Chip>
          ))}
        </ChipGroup>

        <div className="mt-10 flex flex-col gap-8">
          {form.mode === "trade_in" ? (
            <Field
              label="Buy-in"
              htmlFor="bulk-trade-in"
              layout="stacked"
              hint="Scan or type"
            >
              <Input
                id="bulk-trade-in"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                leadingIcon={<BarcodeGlyph />}
                placeholder="GG-BI-000123"
                value={form.tradeIn}
                aria-invalid={problem ? true : undefined}
                onChange={(event) => set({ tradeIn: event.target.value })}
              />
            </Field>
          ) : null}

          {form.mode === "dates" ? (
            <>
              <div className="flex flex-col gap-8 min-[560px]:flex-row min-[560px]:gap-10">
                <Field
                  label="From"
                  htmlFor="bulk-from"
                  layout="stacked"
                  className="min-[560px]:w-52"
                >
                  <Input
                    id="bulk-from"
                    type="date"
                    value={form.from}
                    aria-invalid={problem ? true : undefined}
                    onChange={(event) => set({ from: event.target.value })}
                  />
                </Field>
                <Field
                  label="To"
                  htmlFor="bulk-to"
                  layout="stacked"
                  className="min-[560px]:w-52"
                >
                  <Input
                    id="bulk-to"
                    type="date"
                    value={form.to}
                    aria-invalid={problem ? true : undefined}
                    onChange={(event) => set({ to: event.target.value })}
                  />
                </Field>
              </div>

              <Field label="Location" htmlFor="bulk-location" layout="stacked">
                <Select
                  value={form.location || null}
                  onValueChange={(next: string | null) => set({ location: next ?? "" })}
                >
                  <SelectTrigger id="bulk-location">
                    <SelectValue placeholder="Anywhere">
                      {(value: string) =>
                        locations.find((row) => row.id === value)?.name ?? "Anywhere"
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Anywhere</SelectItem>
                    {locations.map((row) => (
                      <SelectItem key={row.id} value={row.id}>
                        {row.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Kind" htmlFor="bulk-kind" layout="stacked">
                <Select
                  value={form.kind || null}
                  onValueChange={(next: string | null) =>
                    set({ kind: (next ?? "") as ItemKind | "" })
                  }
                >
                  <SelectTrigger id="bulk-kind">
                    <SelectValue placeholder="Any kind">
                      {(value: string) =>
                        KINDS.find((row) => row.value === value)?.label ?? "Any kind"
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Any kind</SelectItem>
                    {KINDS.map((row) => (
                      <SelectItem key={row.value} value={row.value}>
                        {row.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Game" htmlFor="bulk-game" layout="stacked">
                <Select
                  value={form.game || null}
                  onValueChange={(next: string | null) => set({ game: next ?? "" })}
                >
                  <SelectTrigger id="bulk-game">
                    <SelectValue placeholder="Any game">
                      {(value: string) =>
                        games.find((row) => row.id === value)?.name ?? "Any game"
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Any game</SelectItem>
                    {games.map((row) => (
                      <SelectItem key={row.id} value={row.id}>
                        {row.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </>
          ) : null}

          {form.mode === "codes" ? (
            <Field
              label="Codes"
              htmlFor="bulk-codes"
              layout="stacked"
              hint="Commas between"
            >
              <Textarea
                id="bulk-codes"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                placeholder="GGS-7F3K2Q, GGS-T4M9PB"
                value={form.codes}
                aria-invalid={problem ? true : undefined}
                onChange={(event) => set({ codes: event.target.value })}
              />
            </Field>
          ) : null}

          <Field label="Already waiting" layout="stacked">
            <div className="flex items-center gap-4">
              <Switch
                checked={form.includeQueued}
                onCheckedChange={(checked: boolean) => set({ includeQueued: checked })}
                aria-label="Print a label for an item that already has one waiting"
              />
              <span className="text-[15px] text-foreground">
                {form.includeQueued ? "Print another" : "Skip them"}
              </span>
            </div>
          </Field>
        </div>

        <FieldError>{problem}</FieldError>
        {outcome && !problem ? (
          <p
            data-testid="bulk-outcome"
            aria-live="polite"
            className="mt-6 text-[15px] text-foreground"
          >
            {outcome}
          </p>
        ) : null}
      </SheetBody>

      <SheetFooter>
        <Button trailingArrow loading={queue.isPending} onClick={submit}>
          Queue labels
        </Button>
        <Button variant="text" onClick={onDone}>
          {outcome ? "Close" : "Cancel"}
        </Button>
      </SheetFooter>
    </>
  )
}

export function BulkReprintSheet({
  open,
  onOpenChange,
  onQueued,
}: BulkReprintSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        data-testid="bulk-reprint-sheet"
        className="pb-[env(safe-area-inset-bottom)]"
      >
        <SheetHeader>
          <SheetTitle>Reprint labels</SheetTitle>
          <SheetDescription>
            A whole buy-in, everything that came in between two dates, or the
            labels you have in your hand.
          </SheetDescription>
        </SheetHeader>
        {/* Mounted with the sheet, so the form starts empty every time. */}
        <Form onQueued={onQueued} onDone={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  )
}
