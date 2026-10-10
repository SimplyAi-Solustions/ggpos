import { describe, expect, it } from "vitest"

import { portalLinkFrom } from "@/features/portal/notification-link"

describe("portalLinkFrom", () => {
  it("takes a portal path as it stands", () => {
    expect(portalLinkFrom("/account/quotes/abc123")).toBe("/account/quotes/abc123")
    expect(portalLinkFrom("/account/want-list")).toBe("/account/want-list")
  })

  it("takes the Guild's own three destinations", () => {
    // `tier_up` and `referral_earned` link to the Guild, `reward_issued` and
    // `reward_used` to the rewards screen, and the two points rows to the
    // history. All three are real routes, so none of them is rewritten.
    expect(portalLinkFrom("/account/guild")).toBe("/account/guild")
    expect(portalLinkFrom("/account/rewards")).toBe("/account/rewards")
    expect(portalLinkFrom("/account/points")).toBe("/account/points")
  })

  it("puts a path that names no section inside the portal", () => {
    expect(portalLinkFrom("/wants")).toBe("/account/wants")
  })

  it("refuses a protocol-relative URL, which leaves the site", () => {
    expect(portalLinkFrom("//evil.example/account")).toBeNull()
  })

  it("refuses anything with a scheme on it", () => {
    expect(portalLinkFrom("https://evil.example")).toBeNull()
    expect(portalLinkFrom("javascript:alert(1)")).toBeNull()
  })

  it("refuses a backslash, which some browsers read as a slash", () => {
    expect(portalLinkFrom("/\\evil.example")).toBeNull()
    expect(portalLinkFrom("\\\\evil.example")).toBeNull()
  })

  it("refuses a relative path with no leading slash", () => {
    expect(portalLinkFrom("account/quotes")).toBeNull()
  })

  it("answers null for nothing at all", () => {
    expect(portalLinkFrom(undefined)).toBeNull()
    expect(portalLinkFrom("")).toBeNull()
    expect(portalLinkFrom("   ")).toBeNull()
  })

  it("keeps a query string, which a link may carry", () => {
    expect(portalLinkFrom("/account/quotes?open=1")).toBe("/account/quotes?open=1")
  })
})
