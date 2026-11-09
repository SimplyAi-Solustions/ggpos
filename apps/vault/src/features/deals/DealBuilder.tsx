import * as React from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { AnimatePresence, motion } from "motion/react"
import { Check, ChevronLeft, CloudOff, Layers, Loader2, PenLine, QrCode, ScanLine, Search, Trash2 } from "lucide-react"

import { Button, buttonClasses, EmptyState, IconButton, Sheet, useToast } from "@/ui"

import * as api from "./api"
import { CardSearchSheet } from "./components/CardSearchSheet"
import { CustomerViewSheet } from "./components/CustomerViewSheet"
import { CustomItemSheet } from "./components/CustomItemSheet"
import { DealLineRow } from "./components/DealLineRow"
import { FinalOverridePanel } from "./components/FinalOverridePanel"
import { RateControl } from "./components/RateControl"
import { CompleteSheet } from "./components/CompleteSheet"
import { ReviewSheet } from "./components/ReviewSheet"
import { TotalsBar } from "./components/TotalsBar"
import { customLine, draftPayout, itemCount, linePriced, priceDraft } from "./state"
import { addScannedCards, parseScanAdds } from "./scan-adds"
import type { CompletionResult, DealDraft } from "./types"
import { useDealBuilder, type SaveState } from "./useDealBuilder"

type SheetName = "search" | "custom" | "review" | "complete" | "customer" | "delete" | null

/** Cards sent by Scan: the raw ?add= and ?condition= lists (see scan-adds.ts). */
export interface AddFromScan {
  add: string
  condition?: string
}

/** The deal builder: rates, lines, the final figure and review. Phone first. */
export function DealBuilder({
  initial,
  addFromScan,
  onCompleted,
}: {
  initial: DealDraft
  /** A card the Scan screen sent over (?add=<cardId>&condition=NM). */
  addFromScan?: AddFromScan
  onCompleted: (result: CompletionResult) => void
}) {
  const { draft, dispatch, saveState, saveError, flush, addCard, retryPrices } = useDealBuilder(initial)
  const deal = React.useMemo(() => priceDraft(draft), [draft])
  const payout = React.useMemo(() => draftPayout(draft, deal), [draft, deal])
  const [sheet, setSheet] = React.useState<SheetName>(null)
  const navigate = useNavigate()
  const toast = useToast()
  const close = React.useCallback(() => setSheet(null), [])

  const canReview = draft.lines.length > 0 && draft.lines.every(linePriced)

  // Cards from Scan: add them once, then drop the search params so a reload does not add them again.
  const scanned = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!addFromScan?.add) return
    const key = `${addFromScan.add}|${addFromScan.condition ?? ""}`
    if (scanned.current === key) return
    scanned.current = key
    const adds = parseScanAdds(addFromScan.add, addFromScan.condition)
    void addScannedCards(adds, api.getCard, addCard)
      .then((outcome) => {
        if (outcome.added > 0) {
          toast(outcome.onlyName ? `${outcome.onlyName} added.` : `${outcome.added} cards added.`)
        }
        if (outcome.missing > 0) {
          toast({
            message: `${outcome.missing === 1 ? "One card is" : `${outcome.missing} cards are`} not in the catalogue. Search for ${outcome.missing === 1 ? "it" : "them"} or add a custom item.`,
            tone: "alert",
          })
        }
        if (outcome.failed > 0) {
          toast({
            message: `${outcome.failed === 1 ? "One scanned card" : `${outcome.failed} scanned cards`} did not load. ${api.explain(outcome.error, "Search for them instead.")}`,
            tone: "alert",
          })
        }
      })
      .finally(() => {
        void navigate({ to: "/deals/$id", params: { id: draft.id }, search: {}, replace: true })
      })
  }, [addFromScan, addCard, draft.id, navigate, toast])

  const remove = async () => {
    try {
      await api.deleteDeal(draft.id)
      toast("Draft deleted.")
      void navigate({ to: "/deals" })
    } catch (error) {
      toast({ message: api.explain(error, "The draft was not deleted. Try again."), tone: "alert" })
    }
  }

  return (
    <div className="flex flex-col">
      <div className="mb-1 flex items-center justify-between gap-2">
        <Link to="/deals" className="-ml-2 flex h-9 items-center gap-0.5 rounded-sm px-2 text-sm font-medium text-fg-2 hover:text-fg">
          <ChevronLeft className="size-4" aria-hidden />
          Deals
        </Link>
        <div className="flex items-center gap-1">
          <SaveIndicator state={saveState} message={saveError} />
          <IconButton label="Show customer" size="sm" onClick={() => setSheet("customer")} disabled={!draft.lines.length}>
            <QrCode aria-hidden />
          </IconButton>
          <IconButton label="Delete draft" size="sm" onClick={() => setSheet("delete")}>
            <Trash2 aria-hidden />
          </IconButton>
        </div>
      </div>

      <DealName name={draft.name} onChange={(name) => dispatch({ type: "rename", name })} />
      {saveState === "error" && saveError && (
        <p className="mb-2 rounded-md border border-pop/50 px-3 py-2 text-sm text-pop-text" role="alert">
          Not saved. {saveError}
        </p>
      )}

      <div className="sticky top-[calc(56px+var(--safe-top))] z-20 -mx-4 border-b border-line bg-bg/85 px-4 pt-2 pb-3 backdrop-blur-md md:-mx-6 md:px-6">
        <div className="flex gap-3">
          <RateControl
            label="Trade"
            tone="pop"
            value={draft.rates.tradePct}
            onChange={(pct) => dispatch({ type: "setRate", side: "trade", pct })}
          />
          <RateControl
            label="Cash"
            tone="volt"
            value={draft.rates.cashPct}
            onChange={(pct) => dispatch({ type: "setRate", side: "cash", pct })}
          />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2">
        <Button className="px-2" icon={<Search className="size-4 shrink-0" aria-hidden />} onClick={() => setSheet("search")}>
          Add card
        </Button>
        <Link to="/scan" search={{ deal: draft.id } as never} className={`${buttonClasses("secondary", "md")} px-2`} aria-label="Scan cards into this deal">
          <ScanLine className="size-4 shrink-0" aria-hidden />
          Scan
        </Link>
        <Button variant="secondary" className="px-2" icon={<Layers className="size-4 shrink-0" aria-hidden />} onClick={() => setSheet("custom")}>
          Custom
        </Button>
      </div>

      <section aria-label="Lines" className="mt-4">
        {draft.lines.length === 0 ? (
          <EmptyState icon={<Search aria-hidden />} title="No cards yet">
            Search or scan the customer's cards. Retro games, comics and sealed go in as custom items.
          </EmptyState>
        ) : (
          <div className="rounded-lg border border-line bg-panel px-4 shadow-panel sm:px-5 dark:bg-panel-2">
            <ul className="divide-y divide-line">
              <AnimatePresence initial={false}>
                {draft.lines.map((line, i) => (
                  <motion.li
                    key={line.id}
                    layout="position"
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <DealLineRow line={line} priced={deal.lines[i]!} dispatch={dispatch} onRetryPrices={retryPrices} />
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          </div>
        )}
      </section>

      {draft.lines.length > 0 && (
        <div className="mt-6">
          <FinalOverridePanel deal={deal} overrides={draft.overrides} dispatch={dispatch} />
        </div>
      )}

      <TotalsBar deal={deal} items={itemCount(draft.lines)} canReview={canReview} onReview={() => setSheet("review")} />

      <CardSearchSheet open={sheet === "search"} onClose={close} onAdd={addCard} />
      <CustomItemSheet
        open={sheet === "custom"}
        onClose={close}
        onAdd={(item) => dispatch({ type: "addLine", line: customLine(item) })}
      />
      <ReviewSheet
        open={sheet === "review"}
        onClose={close}
        draft={draft}
        deal={deal}
        dispatch={dispatch}
        onContinue={() => setSheet("complete")}
      />
      <CompleteSheet
        open={sheet === "complete"}
        onClose={() => setSheet("review")}
        draft={draft}
        deal={deal}
        payout={payout}
        onSeller={(seller) => dispatch({ type: "setSeller", seller })}
        flush={flush}
        onDone={(result) => {
          setSheet(null)
          onCompleted(result)
        }}
      />
      <CustomerViewSheet open={sheet === "customer"} onClose={close} draft={draft} deal={deal} />
      <Sheet
        open={sheet === "delete"}
        onClose={close}
        title="Delete draft"
        description={`${draft.name} and its ${draft.lines.length} ${draft.lines.length === 1 ? "line" : "lines"} go for good.`}
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" block onClick={close}>
              Keep it
            </Button>
            <Button variant="danger" block onClick={remove}>
              Delete draft
            </Button>
          </div>
        }
      />
    </div>
  )
}

function SaveIndicator({ state, message }: { state: SaveState; message: string | null }) {
  return (
    <span
      className="label-mono mr-1 flex items-center gap-1 text-fg-3"
      role="status"
      aria-live="polite"
      title={state === "error" ? (message ?? undefined) : undefined}
    >
      {state === "saving" && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
      {state === "saved" && <Check className="size-3.5 text-ok" aria-hidden />}
      {state === "error" && <CloudOff className="size-3.5 text-pop-text" aria-hidden />}
      {state === "saving" ? "Saving" : state === "saved" ? "Saved" : "Not saved"}
    </span>
  )
}

function DealName({ name, onChange }: { name: string; onChange: (name: string) => void }) {
  const ref = React.useRef<HTMLInputElement>(null)
  return (
    <div className="group mb-2 flex items-center gap-2">
      <label className="sr-only" htmlFor="deal-name">
        Deal name
      </label>
      <input
        id="deal-name"
        ref={ref}
        value={name}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => {
          if (!e.target.value.trim()) onChange("Untitled deal")
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur()
        }}
        className="min-w-0 flex-1 truncate rounded-sm bg-transparent font-display text-[clamp(1.75rem,1.3rem+2vw,2.5rem)] leading-tight tracking-wide uppercase outline-none focus:bg-panel-2"
      />
      <IconButton label="Rename deal" size="sm" onClick={() => ref.current?.select()}>
        <PenLine aria-hidden />
      </IconButton>
    </div>
  )
}
