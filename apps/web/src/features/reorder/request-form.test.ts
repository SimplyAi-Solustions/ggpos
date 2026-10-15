import { describe, expect, it } from "vitest"

import { requestProblems, type RequestDraft } from "@/features/reorder/request-form"
import type { SaleCustomer } from "@/lib/api/types"

const DRAFT: RequestDraft = {
  title: "Combat Patrol: Necrons",
  qty: 1,
  customer: null,
  contactName: "Sam Whitlock",
  contactPhone: "",
  notes: "",
}

const MEMBER = { id: "cust_demo_2", name: "Tom Bradbury", code: "GGC9QB3X" } as SaleCustomer

describe("the Add a request checks", () => {
  it("passes a request with a name to contact, or with a member", () => {
    expect(requestProblems(DRAFT)).toEqual({})
    expect(requestProblems({ ...DRAFT, contactName: "", customer: MEMBER })).toEqual({})
  })

  it("says each problem in the hook's own words", () => {
    expect(requestProblems({ ...DRAFT, title: "  ", qty: "", contactName: " " })).toEqual({
      title: "Say what the customer is after.",
      qty: "The quantity is a whole number, 1 or more.",
      who: "Add the customer, or a name to contact, so they can be told when it comes in.",
    })
    expect(requestProblems({ ...DRAFT, qty: 0 }).qty).toBe("The quantity is a whole number, 1 or more.")
  })
})
