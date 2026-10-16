/**
 * The part-exchange behind the ticket's Trade-in panel: the shop's offer
 * bands, the draft trade-in and its lines saved as they change, and what the
 * seller's record says about paying them in cash.
 *
 * The lines are the buy-in wizard's, priced through its machine at the
 * credit rate (docs/api-contract-epos.md, section 7: "each accepted line's
 * `offer_price` set to its credit offer"), and written through the
 * collection API the way the wizard writes them, with its own save rules
 * (`saving.ts`): a shape counts as saved only once the server has it.
 *
 * Mounted with the till rather than the panel, so a line still saving when
 * the panel closes is not lost, and Pay can flush the last change.
 */
import * as React from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { DEFAULT_OFFER_SETTINGS } from "@gg/shared/pricing"
import { evaluateTradeInPoints } from "@gg/shared/loyalty"

import {
  idGate,
  toLineInputs,
  type IdGate,
  type TradeLine,
  type WizardCustomer,
} from "@/features/tradein/machine"
import { needsFlush, needsSave, nextSavedShape, UNSAVED } from "@/features/tradein/saving"
import { toWizardCustomer } from "@/features/tradein/wizard-customer"
import {
  ticketTradeLines,
  tradeFigures,
  type PricingContext,
  type TicketTradeLine,
  type TradeFigures,
} from "@/features/till/exchange"
import type { TicketTrade } from "@/features/till/ticket"
import { dispatchTill, getTill } from "@/features/till/till-store"
import {
  createDraftTradeIn,
  getCustomer,
  getTradeIn,
  latestIdDocument,
  loyaltyRulesFrom,
  offerSettingsFrom,
  programmeFrom,
  refusalOrFallback,
  rulesFrom,
  saveTradeInLines,
  usePricingSettings,
  useVaultConfig,
} from "@/lib/api"

/** What a set of lines looks like to the save rules: everything but the ids. */
function shapeOf(lines: TradeLine[], pricing: PricingContext): string {
  return JSON.stringify(
    toLineInputs(lines, pricing.rules, pricing.settings, "credit", pricing.multipliers).map(
      ({ id: _id, ...rest }) => {
        void _id
        return rest
      }
    )
  )
}

export interface TillTrade {
  pricing: PricingContext
  /** True when the shop has no active offer bands at all. */
  rulesMissing: boolean
  /** V and the cash figure beside it, or null with no trade on the ticket. */
  figures: TradeFigures | null
  /** The accepted lines as the ticket lists them. */
  lines: TicketTradeLine[]
  /** The seller's record, as the cash gate reads it. Null while it loads. */
  seller: WizardCustomer | null
  /** What a cash surplus still needs from the ID step. */
  gate: IdGate
  cashCap: number
  /** Why the lines did not save, in the server's words. */
  saveError: string | null
  /** The trade-in points a credit surplus of this much earns. */
  creditPoints: (credit: number) => number
  /**
   * Writes anything the debounce is still holding and answers with the
   * draft's id, so the server prices the lines the till is showing.
   */
  flush: () => Promise<string>
}

export function useTillTrade(trade: TicketTrade | null, options: { cashChosen: boolean }): TillTrade {
  const { data: config, isSuccess: configLoaded } = useVaultConfig()
  const { conditionMultipliers } = usePricingSettings()
  const rules = React.useMemo(() => (config ? rulesFrom(config) : []), [config])
  const settings = React.useMemo(
    () => (config ? offerSettingsFrom(config) : { ...DEFAULT_OFFER_SETTINGS, cashCap: 800_000 }),
    [config]
  )
  const pricing = React.useMemo<PricingContext>(
    () => ({ rules, settings, multipliers: conditionMultipliers }),
    [rules, settings, conditionMultipliers]
  )

  const [saveError, setSaveError] = React.useState<string | null>(null)
  const id = trade?.tradeInId ?? null
  const customerId = trade?.customerId ?? null

  // ---- The draft ----------------------------------------------------------
  // Created once the panel has a customer, as the wizard creates one on its
  // customer step. One attempt per customer until something changes, so a
  // refusal is shown rather than retried in a loop.
  const draft = useMutation({
    mutationFn: (customer: string) => createDraftTradeIn(customer),
    onSuccess: (record, customer) => {
      setSaveError(null)
      if (getTill().ticket.trade?.customerId !== customer) return
      dispatchTill({ type: "trade", action: { type: "set-draft", tradeInId: record.id } })
    },
    onError: (error) =>
      setSaveError(refusalOrFallback(error, "The trade-in could not be started. Check the connection.")),
  })
  const attempted = React.useRef<string | null>(null)
  const lineCount = trade?.lines.length ?? 0
  const { mutate: startDraft, isPending: starting } = draft
  React.useEffect(() => {
    if (!customerId || id || starting) return
    const key = `${customerId}:${lineCount}`
    if (attempted.current === key) return
    attempted.current = key
    startDraft(customerId)
  }, [customerId, id, starting, lineCount, startDraft])

  // A draft kept with the ticket through a reload or a recall may have gone
  // (completed, or a demo shop that started again): then the lines are
  // written to a new one rather than to nothing.
  const existing = useQuery({
    queryKey: ["till-trade-draft", id],
    queryFn: () => getTradeIn(id as string),
    enabled: Boolean(id),
    staleTime: Infinity,
    retry: false,
  })
  React.useEffect(() => {
    if (!id || existing.data === undefined) return
    const gone = existing.data === null || existing.data.status === "completed"
    const now = getTill()
    if (gone && now.phase === "ticket" && now.ticket.trade?.tradeInId === id) {
      dispatchTill({ type: "rebaseTrade" })
    }
  }, [id, existing.data])

  // ---- Lines, saved as they change -----------------------------------------
  const lines = React.useMemo(() => trade?.lines ?? [], [trade?.lines])
  const shape = shapeOf(lines, pricing)
  const saved = React.useRef<{ id: string | null; shape: string }>({ id: null, shape: "[]" })
  const hasSavedIds = lines.some((line) => line.id)
  const failures = React.useRef(0)

  const saveLines = useMutation({
    mutationFn: ({ draftId, input }: { draftId: string; input: TradeLine[]; shape: string }) =>
      saveTradeInLines(
        draftId,
        toLineInputs(input, pricing.rules, pricing.settings, "credit", pricing.multipliers)
      ),
    onSuccess: (records, variables) => {
      failures.current = 0
      setSaveError(null)
      saved.current = { id: variables.draftId, shape: nextSavedShape("saved", variables.shape) }
      if (getTill().ticket.trade?.tradeInId !== variables.draftId) return
      dispatchTill({
        type: "trade",
        action: { type: "adopt-line-ids", ids: records.map((record) => record.id) },
      })
    },
    onError: (error, variables) => {
      failures.current += 1
      saved.current = { id: variables.draftId, shape: nextSavedShape("failed", variables.shape) }
      setSaveError(refusalOrFallback(error, "The trade-in lines did not save. Check the connection."))
    },
  })

  const { mutate: save, isPending: saving } = saveLines
  React.useEffect(() => {
    if (!id) return undefined
    // A draft this hook has not saved yet: nothing on it when it was just
    // made, or unknown when it came back with the ticket.
    const known =
      saved.current.id === id ? saved.current.shape : hasSavedIds ? UNSAVED : "[]"
    if (!needsSave(shape, known, saving)) return undefined
    // Half a second after the last change, as the wizard waits; longer after
    // a failure, so a dropped line is not hammered.
    const delay = failures.current > 0 ? Math.min(10_000, 2_000 * failures.current) : 500
    const timer = window.setTimeout(() => {
      const current = getTill().ticket.trade
      if (!current || current.tradeInId !== id) return
      save({ draftId: id, input: current.lines, shape: shapeOf(current.lines, pricing) })
    }, delay)
    return () => window.clearTimeout(timer)
  }, [id, shape, hasSavedIds, saving, save, pricing])

  const flush = React.useCallback(async (): Promise<string> => {
    const current = getTill().ticket.trade
    if (!current?.tradeInId) throw new Error("The trade-in is still being saved. Give it a moment.")
    const draftId = current.tradeInId
    const currentShape = shapeOf(current.lines, pricing)
    const known = saved.current.id === draftId ? saved.current.shape : UNSAVED
    if (needsFlush(currentShape, known)) {
      const written = await saveTradeInLines(
        draftId,
        toLineInputs(current.lines, pricing.rules, pricing.settings, "credit", pricing.multipliers)
      )
      saved.current = { id: draftId, shape: currentShape }
      dispatchTill({
        type: "trade",
        action: { type: "adopt-line-ids", ids: written.map((record) => record.id) },
      })
    }
    return draftId
  }, [pricing])

  // ---- The seller ------------------------------------------------------------
  const profile = useQuery({
    queryKey: ["customer", customerId],
    queryFn: () => getCustomer(customerId as string),
    enabled: Boolean(customerId),
    staleTime: 30_000,
  })
  const seller = profile.data ? toWizardCustomer(profile.data) : null
  // Whether a photo the retention cron has not purged is still on file: the
  // route refuses a cash payout without one.
  const document = useQuery({
    queryKey: ["id-document", customerId ?? ""],
    queryFn: () => latestIdDocument(customerId as string),
    enabled: Boolean(customerId) && options.cashChosen,
    staleTime: 60_000,
  })
  const gate = idGate(seller?.facts ?? { flags: [], idStatus: "none" }, {
    hasPhoto: document.isSuccess ? document.data !== null : null,
  })

  const creditPoints = React.useCallback(
    (credit: number) =>
      config && credit > 0
        ? evaluateTradeInPoints(programmeFrom(config), loyaltyRulesFrom(config), credit, new Date())
        : 0,
    [config]
  )

  return {
    pricing,
    rulesMissing: configLoaded && rules.length === 0,
    figures: trade ? tradeFigures(lines, pricing) : null,
    lines: trade ? ticketTradeLines(lines, pricing) : [],
    seller,
    gate,
    cashCap: settings.cashCap,
    saveError,
    creditPoints,
    flush,
  }
}
