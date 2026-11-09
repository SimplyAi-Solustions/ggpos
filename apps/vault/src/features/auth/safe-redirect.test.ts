import { describe, expect, it } from "vitest"

import { safeRedirect } from "./safe-redirect"

describe("safeRedirect", () => {
  it("keeps a path on this site", () => {
    expect(safeRedirect("/deals/abc")).toBe("/deals/abc")
  })

  it("refuses other origins and loops", () => {
    expect(safeRedirect("https://evil.example")).toBe("/scan")
    expect(safeRedirect("//evil.example")).toBe("/scan")
    expect(safeRedirect("/\\evil.example")).toBe("/scan")
    expect(safeRedirect("/login?redirect=/x")).toBe("/scan")
    expect(safeRedirect(undefined)).toBe("/scan")
  })
})
