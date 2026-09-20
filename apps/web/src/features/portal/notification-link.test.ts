import { describe, expect, it } from "vitest"

import { portalLinkFrom } from "@/features/portal/notification-link"

describe("portalLinkFrom", () => {
  it("takes a portal path as it stands", () => {
    expect(portalLinkFrom("/account/quotes/abc123")).toBe("/account/quotes/abc123")
    expect(portalLinkFrom("/account/want-list")).toBe("/account/want-list")
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
