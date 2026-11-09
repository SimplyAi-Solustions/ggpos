import * as React from "react"
import { describe, expect, it, vi } from "vitest"
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import * as api from "./api"
import { DealLineRow } from "./components/DealLineRow"
import { FinalOverridePanel } from "./components/FinalOverridePanel"
import { CompleteSheet } from "./components/CompleteSheet"
import { ReviewSheet } from "./components/ReviewSheet"
import { cardLineFromHit, dealReducer, draftPayout, newDraft, priceDraft } from "./state"
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
  function renderReview(initial: DealDraft, onContinue = vi.fn()) {
    // Stable, as the builder's own close callback is: the Sheet refocuses when it changes.
    const onClose = vi.fn()
    render(
      <Harness initial={initial}>
        {(draft, dispatch) => (
          <ReviewSheet open onClose={onClose} draft={draft} deal={priceDraft(draft)} dispatch={dispatch} onContinue={onContinue} />
        )}
      </Harness>
    )
    return onContinue
  }

  it("splits £100 trade / £87.50 cash, £35 taken, into £60 credit and flags the ID check", async () => {
    const onContinue = renderReview({ ...newDraft("d"), lines: [line("a", 12500)] })
    expect(screen.queryByTestId("id-required")).toBeNull()

    await userEvent.click(screen.getByRole("radio", { name: "Split" }))
    await userEvent.type(screen.getByLabelText("Cash they want"), "35")
    const payout = screen.getByTestId("payout")
    expect(payout).toHaveTextContent("£60.00")
    expect(payout).toHaveTextContent("£35.00")
    expect(screen.getByTestId("id-required")).toHaveTextContent("ID on file required")
    await userEvent.click(screen.getByRole("button", { name: "Seller and ID check" }))
    expect(onContinue).toHaveBeenCalled()
  })

  it("needs ID for a penny of cash", async () => {
    renderReview({ ...newDraft("d"), lines: [line("a", 12500)] })
    await userEvent.click(screen.getByRole("radio", { name: "Split" }))
    await userEvent.type(screen.getByLabelText("Cash they want"), "0.01")
    expect(screen.getByTestId("id-required")).toBeInTheDocument()
  })

  it("rounds the final figure and shows value captured for credit", async () => {
    renderReview({ ...newDraft("d"), lines: [line("a", 24389)] }) // trade £195.11
    expect(screen.getByText("Value captured")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: /£195\.00/ }))
    expect(screen.getByTestId("payout")).toHaveTextContent("£195.00")
    expect(screen.getByText(/Final figure overridden/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Seller and terms" })).toBeEnabled()
  })
})

describe("CompleteSheet", () => {
  const seller = { id: "c1", name: "Sam Hill", code: "GGC1", phone: "07700900456", email: "" }

  function renderComplete(draft: DealDraft, onDone = vi.fn()) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onClose = vi.fn()
    const flush = vi.fn().mockResolvedValue(undefined)
    function Wrapper() {
      const [state, dispatch] = React.useReducer(dealReducer, draft)
      const deal = priceDraft(state)
      return (
        <CompleteSheet
          open
          onClose={onClose}
          draft={state}
          deal={deal}
          payout={draftPayout(state, deal)}
          onSeller={(s) => dispatch({ type: "setSeller", seller: s })}
          flush={flush}
          onDone={onDone}
        />
      )
    }
    render(
      <QueryClientProvider client={client}>
        <Wrapper />
      </QueryClientProvider>
    )
    return { flush, onDone }
  }

  it("needs a seller first", () => {
    renderComplete({ ...newDraft("d"), lines: [line("a", 12500)] })
    expect(screen.getByTestId("complete-blocker")).toHaveTextContent("Pick or add the seller.")
    expect(screen.getByRole("button", { name: /Complete deal/ })).toBeDisabled()
  })

  it("completes a credit deal: terms, then the server books it in", async () => {
    vi.spyOn(api, "getServerDeal").mockResolvedValue({ trade_total: 10000, cash_total: 8750, market_total: 12500, lines: [] })
    const complete = vi.spyOn(api, "completeDeal").mockResolvedValue({
      tradeIn: { id: "d", number: "GG-BI-000007", payoutType: "credit", cashTaken: 0, creditGiven: 10000 },
      items: [{ id: "i1", sku: "GGS7F3K2Q", title: "Charizard" }],
      labelsQueued: 1,
    })
    const { flush } = renderComplete({ ...newDraft("d"), seller, lines: [line("a", 12500)] })
    expect(screen.queryByText("ID check")).toBeNull()
    expect(screen.getByTestId("complete-blocker")).toHaveTextContent(/terms/)
    await userEvent.click(screen.getByRole("checkbox"))
    await userEvent.click(screen.getByRole("button", { name: "Complete deal, £100.00" }))
    expect(flush).toHaveBeenCalled()
    expect(complete).toHaveBeenCalledWith("d", { cash_taken: 0, credit_given: 10000, terms_accepted: true, id_check: null })
    const done = await screen.findByTestId("completion")
    expect(done).toHaveTextContent("GG-BI-000007")
    expect(done).toHaveTextContent("GGS7F3K2Q")
    expect(done).toHaveTextContent("1 label queued")
  })

  it("asks for the full ID check before any cash, and will not complete without it", async () => {
    vi.spyOn(api, "getSellerFacts").mockResolvedValue({ idStatus: "none", idExpiry: "", dob: "", address: "", flags: [], hasPhoto: false })
    const complete = vi.spyOn(api, "completeDeal")
    renderComplete({ ...newDraft("d"), seller, lines: [line("a", 12500)], payout: { type: "mixed", cashTaken: 1 } })
    expect(await screen.findByRole("button", { name: "Photograph the ID" })).toBeInTheDocument()
    expect(screen.getByTestId("complete-blocker")).toHaveTextContent("Photograph the ID before you continue.")
    const button = screen.getByRole("button", { name: /Complete deal/ })
    expect(button).toBeDisabled()
    await userEvent.click(button)
    expect(complete).not.toHaveBeenCalled()
  })

  it("passes a seller whose ID and photo are on file", async () => {
    vi.spyOn(api, "getSellerFacts").mockResolvedValue({
      idStatus: "verified",
      idExpiry: "2031-06-30",
      dob: "1990-01-01",
      address: "12 Castle Street, Bolsover, S44 6PP",
      flags: [],
      hasPhoto: true,
    })
    renderComplete({ ...newDraft("d"), seller, lines: [line("a", 12500)], payout: { type: "cash", cashTaken: 0 } })
    expect(await screen.findByTestId("id-on-file")).toBeInTheDocument()
  })

  it("refuses cash to a seller marked no cash", async () => {
    vi.spyOn(api, "getSellerFacts").mockResolvedValue({ idStatus: "verified", idExpiry: "2031-06-30", dob: "", address: "x", flags: ["no_cash"], hasPhoto: true })
    renderComplete({ ...newDraft("d"), seller, lines: [line("a", 12500)], payout: { type: "cash", cashTaken: 0 } })
    expect(await screen.findByRole("alert")).toHaveTextContent("marked no cash")
    expect(screen.getByRole("button", { name: /Complete deal/ })).toBeDisabled()
  })

  it("stops when the server prices the deal differently", async () => {
    vi.spyOn(api, "getServerDeal").mockResolvedValue({ trade_total: 9999, cash_total: 8750, market_total: 12500, lines: [] })
    const complete = vi.spyOn(api, "completeDeal")
    renderComplete({ ...newDraft("d"), seller, lines: [line("a", 12500)] })
    await userEvent.click(screen.getByRole("checkbox"))
    await userEvent.click(screen.getByRole("button", { name: /Complete deal/ }))
    expect(await screen.findByRole("alert")).toHaveTextContent("not what is on screen")
    expect(complete).not.toHaveBeenCalled()
  })
})

describe("useDealBuilder", () => {
  it("autosaves the difference and fetches prices for an added card", async () => {
    vi.spyOn(api, "getConditionPrices").mockResolvedValue({ NM: { pence: 2000, basis: "comp" } })
    const save = vi.spyOn(api, "saveDeal").mockResolvedValue(undefined)
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

    await waitFor(() => expect(result.current.saveState).toBe("saved"), { timeout: 3000 })
    const [previous, next] = save.mock.calls.at(-1)!
    expect(previous).toBe(initial)
    expect(next.lines).toHaveLength(1)
  })

  it("saves a pending edit straight away when the builder closes inside the debounce", async () => {
    const save = vi.spyOn(api, "saveDeal").mockResolvedValue(undefined)
    const client = new QueryClient()
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const { result, unmount } = renderHook(() => useDealBuilder(newDraft("leave")), { wrapper })
    act(() => result.current.dispatch({ type: "rename", name: "Tom's binder" }))
    unmount()
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save.mock.calls[0]![1].name).toBe("Tom's binder")
  })

  it("shows a save failure in plain words", async () => {
    vi.spyOn(api, "saveDeal").mockRejectedValue(new Error("Could not reach the server. Check the connection and try again."))
    const client = new QueryClient()
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useDealBuilder(newDraft("x")), { wrapper })
    act(() => result.current.dispatch({ type: "rename", name: "Tom" }))
    await waitFor(() => expect(result.current.saveState).toBe("error"), { timeout: 3000 })
    expect(result.current.saveError).toMatch(/Could not reach the server/)
  })
})
