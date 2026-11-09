import * as React from "react"
import { describe, expect, it, vi } from "vitest"
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import * as api from "./api"
import { DealLineRow } from "./components/DealLineRow"
import { FinalOverridePanel } from "./components/FinalOverridePanel"
import { ReviewSheet } from "./components/ReviewSheet"
import { cardLineFromHit, dealReducer, newDraft, priceDraft } from "./state"
import type { CardLine, DealDraft } from "./types"
import { useDealBuilder } from "./useDealBuilder"

const hit = {
  id: "c1",
  game: "pokemon",
  name: "Charizard",
  setName: "Base Set",
  setCode: "base1",
  number: "4/102",
  rarity: "",
  image: "",
  finishes: ["holo"],
}

function line(id: string, nm: number, lp?: number): CardLine {
  return {
    ...cardLineFromHit(hit, "holo", id),
    priceStatus: "ready",
    prices: { NM: { pence: nm, basis: "comp" }, ...(lp ? { LP: { pence: lp, basis: "estimated" as const } } : {}) },
  }
}

/** Renders a component wired to the real reducer, so clicks change the draft. */
function Harness({ initial, children }: { initial: DealDraft; children: (d: DealDraft, dispatch: React.Dispatch<Parameters<typeof dealReducer>[1]>) => React.ReactNode }) {
  const [draft, dispatch] = React.useReducer(dealReducer, initial)
  return <>{children(draft, dispatch)}</>
}

describe("DealLineRow", () => {
  it("shows trade and cash side by side with the breakdown", () => {
    const draft = { ...newDraft("d"), lines: [line("a", 51795)] }
    render(<DealLineRow line={draft.lines[0]!} priced={priceDraft(draft).lines[0]!} dispatch={vi.fn()} />)
    expect(screen.getByTestId("breakdown-trade")).toHaveTextContent("80% of £517.95 = £414.36")
    expect(screen.getByTestId("breakdown-cash")).toHaveTextContent("70% of £517.95 = £362.57")
  })

  it("marks a line with its own rate and resets it to the sweep", async () => {
    const initial = { ...newDraft("d"), lines: [line("a", 10000)] }
    render(
      <Harness initial={initial}>
        {(draft, dispatch) => <DealLineRow line={draft.lines[0]!} priced={priceDraft(draft).lines[0]!} dispatch={dispatch} />}
      </Harness>
    )
    expect(screen.queryByTestId("override-marker")).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Line rates" }))
    await userEvent.click(screen.getByRole("button", { name: "Trade 90% for this line" }))
    expect(screen.getByTestId("override-marker")).toHaveTextContent("Own rate")
    expect(screen.getByTestId("breakdown-trade")).toHaveTextContent("90% of £100.00 = £90.00")

    const own = screen.getByLabelText("Cash custom % for this line")
    await userEvent.type(own, "65{Enter}")
    expect(screen.getByTestId("breakdown-cash")).toHaveTextContent("65% of £100.00 = £65.00")

    await userEvent.click(screen.getByRole("button", { name: "Reset to sweep" }))
    expect(screen.queryByTestId("override-marker")).toBeNull()
    expect(screen.getByTestId("breakdown-trade")).toHaveTextContent("80% of £100.00 = £80.00")
  })

  it("swaps to the condition's price and flags an estimate", async () => {
    const initial = { ...newDraft("d"), lines: [line("a", 51795, 27873)] }
    render(
      <Harness initial={initial}>
        {(draft, dispatch) => <DealLineRow line={draft.lines[0]!} priced={priceDraft(draft).lines[0]!} dispatch={dispatch} />}
      </Harness>
    )
    await userEvent.click(screen.getByRole("radio", { name: "LP" }))
    expect(screen.getByTestId("breakdown-trade")).toHaveTextContent("80% of £278.73 = £222.98")
    expect(screen.getByText("Est.")).toBeInTheDocument()
  })
})

describe("FinalOverridePanel", () => {
  it("overrides the trade total, strikes the calculated figure and resets", async () => {
    const initial = { ...newDraft("d"), lines: [line("a", 10000), line("b", 5000)] }
    render(
      <Harness initial={initial}>
        {(draft, dispatch) => (
          <>
            <FinalOverridePanel deal={priceDraft(draft)} overrides={draft.overrides} dispatch={dispatch} />
            <output data-testid="lines">{priceDraft(draft).lines.map((l) => l.trade).join(",")}</output>
          </>
        )}
      </Harness>
    )
    const row = screen.getByTestId("override-trade")
    await userEvent.click(within(row).getByRole("button", { name: "Set" }))
    await userEvent.type(within(row).getByLabelText("Final trade credit"), "100")
    await userEvent.click(within(row).getByRole("button", { name: "Apply" }))
    expect(within(row).getByText("Overridden")).toBeInTheDocument()
    expect(within(row).getByLabelText("Calculated £120.00")).toBeInTheDocument()
    expect(screen.getByTestId("lines")).toHaveTextContent("6667,3333")

    await userEvent.click(within(row).getByRole("button", { name: "Reset" }))
    expect(within(row).queryByText("Overridden")).toBeNull()
    expect(screen.getByTestId("lines")).toHaveTextContent("8000,4000")
  })
})

describe("ReviewSheet", () => {
  function renderReview(initial: DealDraft, onComplete = vi.fn()) {
    // Stable, as the builder's own close callback is: the Sheet refocuses when it changes.
    const onClose = vi.fn()
    render(
      <Harness initial={initial}>
        {(draft, dispatch) => (
          <ReviewSheet
            open
            onClose={onClose}
            draft={draft}
            deal={priceDraft(draft)}
            dispatch={dispatch}
            onComplete={onComplete}
            completing={false}
          />
        )}
      </Harness>
    )
    return onComplete
  }

  it("splits cash and credit, shows the ID requirement and offers no way round it", async () => {
    const onComplete = renderReview({ ...newDraft("d"), lines: [line("a", 12500)] })
    expect(screen.queryByTestId("id-required")).toBeNull()

    await userEvent.click(screen.getByRole("radio", { name: "Split" }))
    await userEvent.type(screen.getByLabelText("Cash they want"), "35")
    const payout = screen.getByTestId("payout")
    expect(payout).toHaveTextContent("£60.00")
    expect(payout).toHaveTextContent("£35.00")
    expect(screen.getByTestId("id-required")).toHaveTextContent("ID on file required")
    const complete = screen.getByRole("button", { name: /Complete deal/ })
    expect(complete).toBeDisabled()
    await userEvent.click(complete)
    expect(onComplete).not.toHaveBeenCalled()
  })

  it("needs ID for a penny of cash", async () => {
    renderReview({ ...newDraft("d"), lines: [line("a", 12500)] })
    await userEvent.click(screen.getByRole("radio", { name: "Split" }))
    await userEvent.type(screen.getByLabelText("Cash they want"), "0.01")
    expect(screen.getByTestId("id-required")).toBeInTheDocument()
  })

  it("rounds the final figure and shows value captured for credit", async () => {
    const onComplete = renderReview({ ...newDraft("d"), lines: [line("a", 24389)] }) // trade £195.11
    expect(screen.getByText("Value captured")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: /£195\.00/ }))
    expect(screen.getByTestId("payout")).toHaveTextContent("£195.00")
    expect(screen.getByText(/Final figure overridden/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Complete deal, £195.00" }))
    expect(onComplete).toHaveBeenCalled()
  })
})

describe("useDealBuilder", () => {
  it("autosaves edits and fetches prices for an added card", async () => {
    vi.spyOn(api, "getConditionPrices").mockResolvedValue({ NM: { pence: 2000, basis: "comp" } })
    const client = new QueryClient()
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const initial = newDraft("auto")
    const { result } = renderHook(() => useDealBuilder(initial), { wrapper })
    expect(result.current.saveState).toBe("saved")

    act(() => result.current.addCard(hit, "holo"))
    expect(result.current.saveState).toBe("saving")
    await waitFor(() => expect((result.current.draft.lines[0] as CardLine).priceStatus).toBe("ready"))
    expect(priceDraft(result.current.draft).trade).toBe(1600)

    await waitFor(() => expect(result.current.saveState).toBe("saved"), { timeout: 2000 })
    const stored = await api.getDeal("auto")
    expect(stored?.lines).toHaveLength(1)
  })
})
