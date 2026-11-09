import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"

import * as api from "./api"
import { cardLineFromHit, dealReducer, type DealAction } from "./state"
import type { CardHit, Condition, DealDraft } from "./types"

export type SaveState = "saved" | "saving" | "error"

const AUTOSAVE_MS = 600

/**
 * The builder's state for one draft: the reducer, a debounced autosave to
 * the server, and the price fetch for each card line.
 *
 * Saves run one at a time. Each one writes the difference between the last
 * draft the server accepted and the draft as it is now, so a slow save is
 * never overtaken by the next and nothing is written twice.
 */
export function useDealBuilder(initial: DealDraft) {
  const [draft, dispatch] = React.useReducer(dealReducer, initial)
  const [saveState, setSaveState] = React.useState<SaveState>("saved")
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const queryClient = useQueryClient()
  const saved = React.useRef(initial)
  const latest = React.useRef(initial)
  const chain = React.useRef<Promise<void>>(Promise.resolve())
  const [retryTick, setRetryTick] = React.useState(0)

  React.useEffect(() => {
    latest.current = draft
  }, [draft])

  React.useEffect(() => {
    if (draft === saved.current || draft.status === "completed") return
    setSaveState("saving")
    const timer = window.setTimeout(() => {
      chain.current = chain.current.then(async () => {
        const next = latest.current
        if (next === saved.current) return
        try {
          await api.saveDeal(saved.current, next)
          saved.current = next
          setSaveError(null)
          setSaveState(latest.current === next ? "saved" : "saving")
          void queryClient.invalidateQueries({ queryKey: ["deals", "list"] })
        } catch (error) {
          setSaveError(api.explain(error, "The deal did not save. Check the connection; it will try again."))
          setSaveState("error")
        }
      })
    }, AUTOSAVE_MS)
    return () => window.clearTimeout(timer)
  }, [draft, queryClient, retryTick])

  // Leaving the builder (Back, another tab, the phone locking) inside the
  // debounce must not lose the last edit: whatever is pending goes now.
  React.useEffect(() => {
    const saveNow = () => {
      const next = latest.current
      if (next === saved.current || next.status === "completed") return
      chain.current = chain.current
        .then(async () => {
          if (next === saved.current) return
          await api.saveDeal(saved.current, next)
          saved.current = next
        })
        .catch(() => {})
    }
    const onHide = () => {
      if (document.visibilityState === "hidden") saveNow()
    }
    document.addEventListener("visibilitychange", onHide)
    window.addEventListener("pagehide", saveNow)
    return () => {
      document.removeEventListener("visibilitychange", onHide)
      window.removeEventListener("pagehide", saveNow)
      saveNow()
    }
  }, [])

  // An unsaved deal tries again every few seconds until it gets through.
  React.useEffect(() => {
    if (saveState !== "error") return
    const timer = window.setTimeout(() => setRetryTick((n) => n + 1), 4000)
    return () => window.clearTimeout(timer)
  }, [saveState])

  /** Waits for every pending change to reach the server. Throws if one did not. */
  const flush = React.useCallback(async () => {
    await chain.current
    if (latest.current !== saved.current) {
      await api.saveDeal(saved.current, latest.current)
      saved.current = latest.current
      setSaveState("saved")
      setSaveError(null)
    }
  }, [])

  const loadPrices = React.useCallback((lineId: string, cardId: string, variant: string) => {
    api
      .getConditionPrices(cardId, variant)
      .then((prices) => dispatch({ type: "setPrices", lineId, prices }))
      .catch(() => dispatch({ type: "pricesFailed", lineId }))
  }, [])

  const addCard = React.useCallback(
    (hit: CardHit, variant: string, condition: Condition = "NM", qty = 1) => {
      const line = cardLineFromHit(hit, variant)
      dispatch({ type: "addLine", line })
      if (condition !== "NM") dispatch({ type: "setCondition", lineId: line.id, condition })
      if (qty > 1) dispatch({ type: "setQty", lineId: line.id, qty })
      loadPrices(line.id, hit.id, variant)
    },
    [loadPrices]
  )

  const retryPrices = React.useCallback(
    (lineId: string) => {
      const line = latest.current.lines.find((l) => l.id === lineId)
      if (line?.kind === "card") loadPrices(line.id, line.cardId, line.variant)
    },
    [loadPrices]
  )

  // Card lines read back from the server load fresh prices; the stored value holds until then.
  React.useEffect(() => {
    if (initial.status === "completed") return
    for (const line of initial.lines) {
      if (line.kind === "card" && line.priceStatus === "loading") loadPrices(line.id, line.cardId, line.variant)
    }
  }, [initial, loadPrices])

  return {
    draft,
    dispatch: dispatch as React.Dispatch<DealAction>,
    saveState,
    saveError,
    flush,
    addCard,
    retryPrices,
  }
}
