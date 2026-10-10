import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ClientResponseError } from "pocketbase"
import { DEFAULT_TCG_PRIORITY } from "@gg/shared"

import * as catalogue from "@/lib/api/demo/catalogue"
import { DEMO_AGENT, demoAgentActions, resetDemoAgents } from "@/lib/api/demo/agents"
import {
  demoCancelResearch,
  demoCreateResearch,
  demoGetResearch,
  demoListResearch,
  resetDemoResearch,
} from "@/lib/api/demo/research"

/**
 * Research in demo mode, which the e2e suite's proof of "ask an agent, see
 * the comps land on the line" rests on: Gandalf claims a new request, then
 * completes it with three comps written as UK sold comps exactly as a staff
 * comp is, and asking twice about the same line wakes nobody twice.
 */

beforeEach(() => {
  vi.useFakeTimers()
  resetDemoResearch()
  resetDemoAgents()
})

afterEach(() => {
  vi.useRealTimers()
})

function refusal(run: () => unknown): { status: number; message: string } {
  try {
    run()
  } catch (error) {
    if (error instanceof ClientResponseError) return { status: error.status, message: error.message }
    throw error
  }
  throw new Error("expected a refusal")
}

describe("demoCreateResearch", () => {
  it("opens a request, and Gandalf claims it then completes it with three UK comps", () => {
    const { request, existing } = demoCreateResearch({
      query: "Charizard ex Scarlet & Violet 151 199/165",
      card: "card_sv151_199",
      trade_in_line: "line_1",
      finish: "normal",
      condition: "LP",
    })
    expect(existing).toBe(false)
    expect(request.status).toBe("open")
    expect(request.ebay_url).toContain("LH_Sold=1&LH_Complete=1")

    vi.advanceTimersByTime(600)
    expect(demoGetResearch(request.id).status).toBe("claimed")
    expect(demoGetResearch(request.id).claimed_by?.name).toBe("Gandalf")

    vi.advanceTimersByTime(1000)
    const done = demoGetResearch(request.id)
    expect(done.status).toBe("done")
    expect(done.comps).toHaveLength(3)
    for (const comp of done.comps) {
      expect(comp.currency).toBe("GBP")
      expect(Number.isInteger(comp.price)).toBe(true)
      expect(comp.url).toMatch(/^https:\/\/www\.ebay\.co\.uk\/itm\/\d+$/)
    }

    // Written as UK sold comps on the card, so they lead its price.
    const view = catalogue.getPrices("card_sv151_199", "normal", DEFAULT_TCG_PRIORITY, 1)
    expect(view.chosen?.source).toBe("uk_sold_manual")
    expect(done.comps.map((comp) => comp.price)).toContain(view.chosen?.gbp_market)

    expect(demoAgentActions(DEMO_AGENT.id)[0]?.action).toBe("research_completed")
  })

  it("answers the open request when asked again about the same line", () => {
    const first = demoCreateResearch({ query: "Mew ex", card: "card_sv151_205", trade_in_line: "line_2" })
    const second = demoCreateResearch({ query: "Mew ex", card: "card_sv151_205", trade_in_line: "line_2" })
    expect(second.existing).toBe(true)
    expect(second.request.id).toBe(first.request.id)
  })

  it("refuses a request with nothing to research, in the server's words", () => {
    expect(refusal(() => demoCreateResearch({}))).toEqual({
      status: 400,
      message: "Say what to research: a card, a retro title, an item, a trade-in line or some search words.",
    })
  })
})

describe("demoListResearch", () => {
  it("filters by status and by line, newest first", () => {
    demoCreateResearch({ query: "Pikachu 025", card: "card_sv151_025", trade_in_line: "line_3" })
    expect(demoListResearch({ status: "open" }).map((row) => row.query)).toContain("Pikachu 025")
    expect(demoListResearch({ trade_in_line: "line_3" })).toHaveLength(1)
    expect(demoListResearch({ status: "done" }).every((row) => row.status === "done")).toBe(true)
    const all = demoListResearch()
    expect(all.map((row) => row.created)).toEqual([...all.map((row) => row.created)].sort().reverse())
  })
})

describe("demoCancelResearch", () => {
  it("cancels an open request, which Gandalf then leaves alone, and refuses a done one", () => {
    const { request } = demoCreateResearch({ query: "GoldenEye 007 boxed", retro_title: "retro_gt", finish: "boxed" })
    expect(demoCancelResearch(request.id).status).toBe("cancelled")
    vi.advanceTimersByTime(3000)
    expect(demoGetResearch(request.id).status).toBe("cancelled")

    const done = demoListResearch({ status: "done" })[0]
    expect(done).toBeDefined()
    expect(refusal(() => demoCancelResearch(done!.id))).toEqual({
      status: 409,
      message: "This request is done. Its comps are in the Research list.",
    })
  })
})
