import { describe, expect, it } from "vitest"

import { isCustomerPath } from "@/lib/customer-path"

describe("isCustomerPath", () => {
  it("matches exactly what the appshell serves account.html for", () => {
    for (const p of ["/account", "/account/", "/account/binders", "/c/b/token123", "/estimate", "/estimate/x"]) {
      expect(isCustomerPath(p), p).toBe(true)
    }
    for (const p of ["/", "/counter", "/counter/stock", "/accounts", "/cards", "/display", "/estimates"]) {
      expect(isCustomerPath(p), p).toBe(false)
    }
  })
})
