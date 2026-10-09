import { describe, expect, it } from "vitest"

import { joinIntro, joinedNote, memberSince, seedFromQuery } from "@/features/guild/words"

describe("the Guild's words at the counter", () => {
  it("says what joining gives", () => {
    expect(joinIntro(100)).toBe("They get 100 points to start.")
    expect(joinIntro(1500)).toBe("They get 1,500 points to start.")
    expect(joinIntro(0)).toBe("Every purchase earns points from today.")
    expect(joinedNote("Jo Bloggs", 100)).toBe("Jo Bloggs joined the Guild with 100 points.")
    expect(joinedNote("Jo Bloggs", 0)).toBe("Jo Bloggs joined the Guild.")
  })

  it("dates a member from either way the server writes a date", () => {
    expect(memberSince("2026-10-09 10:00:00.000Z")).toBe("In the Guild since 9 October 2026")
    expect(memberSince("2026-10-09T10:00:00Z")).toBe("In the Guild since 9 October 2026")
    expect(memberSince("not a date")).toBe("In the Guild")
  })

  it("puts what was searched for where it belongs on a new customer", () => {
    expect(seedFromQuery("Jo Bloggs")).toEqual({ name: "Jo Bloggs", email: "", phone: "" })
    expect(seedFromQuery("jo@example.co.uk")).toEqual({ name: "", email: "jo@example.co.uk", phone: "" })
    expect(seedFromQuery("07700 900123")).toEqual({ name: "", email: "", phone: "07700 900123" })
    expect(seedFromQuery("  ")).toEqual({ name: "", email: "", phone: "" })
  })
})
