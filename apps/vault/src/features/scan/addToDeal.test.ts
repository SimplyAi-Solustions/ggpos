import { describe, expect, it, vi } from "vitest"

import { addToDeal, addToDealHref } from "./addToDeal"

describe("addToDeal", () => {
  it("sends the card to the open deal with NM as the starting condition", () => {
    expect(addToDealHref("d123", "c9")).toBe("/deals/d123?add=c9&condition=NM")
    const navigate = vi.fn()
    addToDeal(navigate, "d123", "c9", "LP")
    expect(navigate).toHaveBeenCalledWith({ href: "/deals/d123?add=c9&condition=LP" })
  })

  it("asks which deal when there is none", () => {
    expect(addToDealHref(null, "c9")).toBe("/deals?add=c9&condition=NM")
  })
})
