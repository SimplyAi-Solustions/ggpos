import * as React from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { DEFAULT_OFFER_SETTINGS } from "@gg/shared/pricing"
import { evaluateTradeInPoints } from "@gg/shared/loyalty"

import { Button } from "@/components/ui/button"
import { PageTitle } from "@/components/ui/page-title"
import { useCounterDock } from "@/app/counter-dock"
import { Prog } from "@/features/tradein/Prog"
import { needsFlush, needsSave, nextSavedShape } from "@/features/tradein/saving"
import { CustomerStep } from "@/features/tradein/steps/CustomerStep"
import { DoneStep } from "@/features/tradein/steps/DoneStep"
import {
  EMPTY_CAPTURE,
  idCaptureProblem,
  idCheckForm,
  type IdCaptureValues,
} from "@/features/tradein/id-capture"
import { IdStep } from "@/features/tradein/steps/IdStep"
import { ItemsStep } from "@/features/tradein/steps/ItemsStep"
import { OfferStep } from "@/features/tradein/steps/OfferStep"
import {
  canAdvance,
  idGate,
  initialState,
  nextStep,
  payoutFor,
  reducer,
  toLineInputs,
  totals,
  visibleSteps,
  type WizardState,
  type WizardStep,
} from "@/features/tradein/machine"
import {
  completeTradeIn,
  createDraftTradeIn,
  currentCashSessionId,
  emailReceipt,
  latestIdDocument,
  loyaltyRulesFrom,
  offerSettingsFrom,
  programmeFrom,
  refusalOrFallback,
  rulesFrom,
  saveTradeInLines,
  submitIdCheck,
  usePricingSettings,
  useVaultConfig,
  type IdCheckPayload,
  type TradeInLineInput,
} from "@/lib/api"

export interface BuyInWizardProps {
  /**
   * A draft reopened from the recent list, already in the wizard's shape
   * (see `hydrate`). A fresh buy-in leaves it out.
   */
  initial?: WizardState
}

/**
 * The buy-in, start to finish.
 *
 * Five steps, one screen, and one primary action at a time in the thumb zone,
 * because this is done standing up with a customer opposite and a phone in
 * one hand. Everything that decides anything is in `machine.ts`; this
 * component holds the server round trips and the one button.
 */
export function BuyInWizard({ initial }: BuyInWizardProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const dock = useCounterDock()
  const [state, dispatch] = React.useReducer(reducer, initial ?? initialState)
  const [capture, setCapture] = React.useState<IdCaptureValues>(EMPTY_CAPTURE)
  const [stepError, setStepError] = React.useState<string | null>(null)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [emailNote, setEmailNote] = React.useState<string | null>(null)
  const [labelNote, setLabelNote] = React.useState<string | null>(null)

  // One read of `/api/vault/config` for the session, shared with the Sell
  // and Cash screens' own slice of it. The offer bands, the cash cap and the
  // loyalty programme all come out of this one answer.
  const { data: config, isSuccess: configLoaded } = useVaultConfig()

  const rules = React.useMemo(() => (config ? rulesFrom(config) : []), [config])
  // The shop's own condition multipliers, which every figure on this screen
  // has to be taken through: the price routes and Add stock already use
  // them, and a buy-in that quietly used the shared defaults instead would
  // underpay whenever an admin had changed one.
  const { conditionMultipliers } = usePricingSettings()
  // Memoised because the line inputs are derived from it: a fresh object on
  // every render would re-save every line on every keystroke.
  const settings = React.useMemo(
    () =>
      config
        ? offerSettingsFrom(config)
        : { ...DEFAULT_OFFER_SETTINGS, cashCap: 800_000 },
    [config]
  )
  const sums = totals(state.lines, rules, settings, conditionMultipliers)
  const payout = payoutFor(state.payoutType, sums, state.mixedCash)
  const cashRequired = payout.cash > 0
  const steps = visibleSteps({ cashRequired })
  const creditPoints = config
    ? evaluateTradeInPoints(
        programmeFrom(config),
        loyaltyRulesFrom(config),
        sums.credit,
        new Date()
      )
    : 0

  // ---- The draft ---------------------------------------------------------
  const draft = useMutation({
    mutationFn: (customerId: string) => createDraftTradeIn(customerId),
    onSuccess: (record) => dispatch({ type: "set-draft", tradeInId: record.id }),
    onError: (error) =>
      setSaveError(
        refusalOrFallback(error, "That buy-in could not be started. Try again.")
      ),
  })

  // ---- Lines, saved as they change ---------------------------------------
  const lineInputs = React.useMemo(
    () =>
      toLineInputs(
        state.lines,
        rules,
        settings,
        state.payoutType,
        conditionMultipliers
      ),
    [state.lines, rules, settings, state.payoutType, conditionMultipliers]
  )
  // The signature leaves the ids out: adopting the ids a save hands back
  // would otherwise look like another change and save a second time.
  const shape = React.useMemo(
    () =>
      JSON.stringify(
        lineInputs.map(({ id: _id, ...rest }) => {
          void _id
          return rest
        })
      ),
    [lineInputs]
  )
  const savedShape = React.useRef(
    initial
      ? JSON.stringify(
          toLineInputs(initial.lines, [], DEFAULT_OFFER_SETTINGS, initial.payoutType).map(
            ({ id: _id, ...rest }) => {
              void _id
              return rest
            }
          )
        )
      : "[]"
  )

  const saveLines = useMutation({
    mutationFn: ({
      id,
      inputs,
    }: {
      id: string
      inputs: TradeInLineInput[]
      shape: string
    }) => saveTradeInLines(id, inputs),
    onSuccess: (records, variables) => {
      setSaveError(null)
      // Marked saved only once the server has it. Marking it before the
      // request is what would lose a line: the shape would look current
      // while nothing had been written.
      savedShape.current = nextSavedShape("saved", variables.shape)
      dispatch({ type: "adopt-line-ids", ids: records.map((record) => record.id) })
    },
    onError: (error) => {
      savedShape.current = nextSavedShape("failed", shape)
      setSaveError(
        refusalOrFallback(error, "Those lines did not save. Check the connection.")
      )
    },
  })

  const id = state.tradeInId
  React.useEffect(() => {
    if (!id) return undefined
    if (!needsSave(shape, savedShape.current, saveLines.isPending)) return undefined
    const timer = window.setTimeout(
      () => saveLines.mutate({ id, inputs: lineInputs, shape }),
      500
    )
    return () => window.clearTimeout(timer)
    // `saveLines` is stable for the life of this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, shape, saveLines.isPending])

  // ---- Completion ---------------------------------------------------------
  /**
   * The ID document this session has already stored for this customer. A
   * refused completion is retried with the same photo rather than taking a
   * second one: the route stores every photo it is sent, and a customer's
   * ID is not something to keep duplicate copies of.
   */
  const storedDocument = React.useRef<{ customer: string; id: string } | null>(null)

  const complete = useMutation({
    mutationFn: async () => {
      if (!state.tradeInId) throw new Error("This buy-in has no draft yet.")

      // Flush anything the debounce is still holding, so the server prices
      // the lines the counter is looking at rather than the ones from
      // before the payout tile was switched.
      if (needsFlush(shape, savedShape.current)) {
        const written = await saveTradeInLines(state.tradeInId, lineInputs)
        savedShape.current = nextSavedShape("saved", shape)
        dispatch({
          type: "adopt-line-ids",
          ids: written.map((record) => record.id),
        })
      }

      let idCheck: IdCheckPayload | null = null
      if (cashRequired && state.customer && gate.needed) {
        const already =
          storedDocument.current?.customer === state.customer.id
            ? storedDocument.current.id
            : null
        const documentId =
          already ??
          (await submitIdCheck(state.customer.id, idCheckForm(capture))).id_document
        storedDocument.current = { customer: state.customer.id, id: documentId }
        idCheck = {
          id_type: capture.idType,
          id_expiry: capture.idExpiry,
          id_ref_last4: capture.idRefLast4,
          dob: capture.dob,
          address: capture.address.trim(),
          id_document: documentId,
        }
      }

      const session = cashRequired ? await currentCashSessionId() : null
      return completeTradeIn(state.tradeInId, {
        payout_type: payout.type,
        payout_cash: payout.cash,
        payout_credit: payout.credit,
        terms_accepted: state.termsAccepted,
        signature: state.signature,
        cash_session: session,
        id_check: idCheck,
      })
    },
    onSuccess: (result) => {
      setStepError(null)
      // The photo blob, the date of birth and the address belong to the
      // person who has just walked away.
      setCapture(EMPTY_CAPTURE)
      storedDocument.current = null
      void queryClient.invalidateQueries({ queryKey: ["customer"] })
      void queryClient.invalidateQueries({ queryKey: ["trade-ins"] })
      dispatch({
        type: "completed",
        number: result.trade_in.number,
        labels: result.labels_queued,
        points: result.points_earned,
        items: result.items,
      })
    },
    onError: (error) =>
      setStepError(
        refusalOrFallback(
          error,
          "That buy-in did not go through. Check the connection and press it again."
        )
      ),
  })

  const email = useMutation({
    mutationFn: () => emailReceipt(state.tradeInId ?? ""),
    onSuccess: (result) =>
      setEmailNote(
        result.sent
          ? "Receipt sent"
          : "Email is in test mode, so nothing was sent. Print the receipt."
      ),
    onError: (error) =>
      setEmailNote(refusalOrFallback(error, "That receipt was not sent.")),
  })

  // ---- The ID gate --------------------------------------------------------
  /**
   * Whether a photo the retention cron has not purged is still on file. A
   * customer verified a year ago can have lost theirs, and the completion
   * route refuses a cash payout without one.
   */
  const { data: idDocument, isSuccess: idDocumentChecked } = useQuery({
    queryKey: ["id-document", state.customer?.id ?? ""],
    queryFn: () => latestIdDocument(state.customer?.id ?? ""),
    enabled: Boolean(state.customer && cashRequired),
    staleTime: 60_000,
  })
  const gate = idGate(
    state.customer?.facts ?? { flags: [], idStatus: "none" },
    { hasPhoto: idDocumentChecked ? idDocument !== null : null }
  )

  // ---- The one button ----------------------------------------------------
  const advanceGate = state.customer
    ? canAdvance(state, sums, payout, settings.cashCap)
    : { ok: state.step !== "customer", reason: "Scan or search for the customer first." }

  const lastStepBeforeDone =
    nextStep(state.step, { cashRequired }) === "done" && state.step !== "done"

  function advance() {
    if (!advanceGate.ok) {
      setStepError(advanceGate.reason)
      return
    }
    if (state.step === "id") {
      const problem = idCaptureProblem(capture, gate)
      if (problem) {
        setStepError(problem)
        return
      }
    }
    setStepError(null)
    if (lastStepBeforeDone) {
      complete.mutate()
      return
    }
    dispatch({ type: "next", ctx: { cashRequired } })
  }

  const primaryLabel =
    state.step === "customer"
      ? "Add items"
      : state.step === "items"
        ? "Make the offer"
        : state.step === "offer"
          ? cashRequired
            ? "Check ID"
            : "Complete buy-in"
          : "Complete buy-in"

  function reset() {
    savedShape.current = "[]"
    setCapture(EMPTY_CAPTURE)
    setEmailNote(null)
    setLabelNote(null)
    setStepError(null)
    dispatch({ type: "reset" })
  }

  /**
   * The same action twice: once in the desktop row at its natural width,
   * once full width in the phone dock. The dock slot exists at every size
   * (it is only hidden by CSS from 900px), so the width cannot be decided
   * from whether the slot is there.
   */
  function primaryButton(full: boolean) {
    if (state.step === "done") return null
    return (
      <Button
        type="button"
        trailingArrow
        loading={complete.isPending || saveLines.isPending}
        onClick={advance}
        className={full ? "w-full" : undefined}
      >
        {primaryLabel}
      </Button>
    )
  }

  return (
    <section className="pt-16 sm:pt-24">
      {state.step === "done" && state.completed ? (
        <DoneStep
          number={state.completed.number}
          labels={state.completed.labels}
          points={state.completed.points}
          items={state.completed.items}
          lines={state.lines}
          payout={payout}
          customerEmail={state.customer?.email ?? ""}
          emailNote={emailNote}
          emailBusy={email.isPending}
          labelNote={labelNote}
          onPrintLabels={() =>
            setLabelNote(
              "Already queued. Open Labels on the counter PC to print them."
            )
          }
          onReceipt={() =>
            void navigate({
              to: "/counter/trade/$id/receipt",
              params: { id: state.tradeInId ?? "" },
            })
          }
          onEmailReceipt={() => email.mutate()}
          onNewBuyIn={reset}
        />
      ) : (
        <>
          <PageTitle>Buy-in</PageTitle>
          <Prog
            className="mt-10"
            steps={steps}
            current={state.step}
            onGo={(step: WizardStep) => {
              setStepError(null)
              dispatch({ type: "go", step })
            }}
          />

          <div className="mt-14">
            {state.step === "customer" ? (
              <CustomerStep
                customer={state.customer}
                onChoose={(customer) => {
                  dispatch({ type: "choose-customer", customer })
                  if (!state.tradeInId) draft.mutate(customer.id)
                }}
                onClear={() => dispatch({ type: "reset" })}
              />
            ) : null}

            {state.step === "items" ? (
              <ItemsStep
                lines={state.lines}
                rules={rules}
                settings={settings}
                multipliers={conditionMultipliers}
                sums={sums}
                rulesMissing={configLoaded && rules.length === 0}
                onAdd={(line) => dispatch({ type: "add-line", line })}
                onUpdate={(key, patch) =>
                  dispatch({ type: "update-line", key, patch })
                }
                onRemove={(key) => dispatch({ type: "remove-line", key })}
                saveError={saveError}
              />
            ) : null}

            {state.step === "offer" && state.customer ? (
              <OfferStep
                customer={state.customer}
                sums={sums}
                payout={payout}
                payoutType={state.payoutType}
                mixedCash={state.mixedCash}
                cashCap={settings.cashCap}
                creditPoints={creditPoints}
                termsAccepted={state.termsAccepted}
                signature={state.signature}
                onPayoutType={(type) =>
                  dispatch({ type: "set-payout", payoutType: type })
                }
                onMixedCash={(pence) =>
                  dispatch({ type: "set-mixed-cash", pence })
                }
                onTerms={(accepted) => dispatch({ type: "set-terms", accepted })}
                onSignature={(signature) =>
                  dispatch({ type: "set-signature", signature })
                }
                blockReason={stepError}
              />
            ) : null}

            {state.step === "id" && state.customer ? (
              <IdStep
                customer={state.customer}
                payout={payout}
                cashCap={settings.cashCap}
                values={capture}
                onChange={(patch) =>
                  setCapture((current) => ({ ...current, ...patch }))
                }
                gate={gate}
                serverError={stepError}
              />
            ) : null}
          </div>

          {stepError && state.step !== "offer" && state.step !== "id" ? (
            <p role="alert" className="mt-8 max-w-[56ch] text-[13px] text-destructive">
              {stepError}
            </p>
          ) : null}

          {/* A line that did not save is worth knowing about on every step,
              not only the one it was typed on. */}
          {saveError && state.step !== "items" ? (
            <p role="alert" className="mt-4 max-w-[56ch] text-[13px] text-destructive">
              {saveError}
            </p>
          ) : null}

          <div className="mt-14 hidden flex-wrap items-center gap-8 min-[900px]:flex">
            {primaryButton(false)}
            {state.step !== "customer" ? (
              <Button
                variant="text"
                type="button"
                onClick={() => {
                  setStepError(null)
                  dispatch({ type: "back" })
                }}
              >
                Back
              </Button>
            ) : (
              <Button
                variant="text"
                type="button"
                onClick={() => void navigate({ to: "/counter/trade" })}
              >
                Cancel
              </Button>
            )}
          </div>

          {dock
            ? createPortal(
                <div className="border-t border-hairline-soft bg-background px-5 py-3">
                  {primaryButton(true)}
                </div>,
                dock
              )
            : null}
        </>
      )}
    </section>
  )
}
