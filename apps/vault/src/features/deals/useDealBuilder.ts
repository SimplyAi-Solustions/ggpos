import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"

import * as api from "./api"
import { cardLineFromHit, dealReducer, newDraft, type DealAction } from "./state"
import type { CardHit, DealDraft } from "./types"

export type SaveState = "saved" | "saving" | "error"

const AUTOSAVE_MS = 500

/**
 * The builder's state for one draft: the reducer, a debounced autosave and
 * the price fetch for a card that has just been added.
 */
export function useDealBuilder(initial: DealDraft) {
  const [draft, dispatch] = React.useReducer(dealReducer, initial)
  const [saveState, setSaveState] = React.useState<SaveState>("saved")
  const queryClient = useQueryClient()
  const lastSaved = React.useRef(initial)

  React.useEffect(() => {
    if (draft === lastSaved.current) return
    setSaveState("saving")
    const timer = window.setTimeout(() => {
      api
        .saveDeal(draft)
        .then(() => {
          lastSaved.current = draft
          setSaveState("saved")
          void queryClient.invalidateQueries({ queryKey: ["deals"] })
        })
        .catch(() => setSaveState("error"))
    }, AUTOSAVE_MS)
    return () => window.clearTimeout(timer)
  }, [draft, queryClient])

  const addCard = React.useCallback((hit: CardHit, variant: string) => {
    const line = cardLineFromHit(hit, variant)
    dispatch({ type: "addLine", line })
    api
      .getConditionPrices(hit.id, variant)
      .then((prices) => dispatch({ type: "setPrices", lineId: line.id, prices }))
      .catch(() => dispatch({ type: "pricesFailed", lineId: line.id }))
  }, [])

  const retryPrices = React.useCallback(
    (lineId: string) => {
      const line = draft.lines.find((l) => l.id === lineId)
      if (!line || line.kind !== "card") return
      api
        .getConditionPrices(line.cardId, line.variant)
        .then((prices) => dispatch({ type: "setPrices", lineId, prices }))
        .catch(() => dispatch({ type: "pricesFailed", lineId }))
    },
    [draft.lines]
  )

  // A line saved while its prices were still loading picks up where it left off.
  React.useEffect(() => {
    for (const line of initial.lines) {
      if (line.kind !== "card" || line.priceStatus !== "loading") continue
      api
        .getConditionPrices(line.cardId, line.variant)
        .then((prices) => dispatch({ type: "setPrices", lineId: line.id, prices }))
        .catch(() => dispatch({ type: "pricesFailed", lineId: line.id }))
    }
  }, [initial])

  return { draft, dispatch: dispatch as React.Dispatch<DealAction>, saveState, addCard, retryPrices }
}

/** Creates and stores a fresh draft. */
export async function createDraft(): Promise<DealDraft> {
  return api.saveDeal(newDraft())
}
