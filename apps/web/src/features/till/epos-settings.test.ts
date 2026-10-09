import { describe, expect, it } from "vitest"

import { EPOS_DEFAULTS, eposSettingsFrom } from "@/features/till/epos-settings"

describe("the till's settings", () => {
  it("are the migration's defaults when the shop has set nothing", () => {
    expect(eposSettingsFrom(undefined)).toEqual(EPOS_DEFAULTS)
    expect(eposSettingsFrom({})).toEqual(EPOS_DEFAULTS)
  })

  it("read what the shop has set", () => {
    expect(
      eposSettingsFrom({
        vat_registered: true,
        epos: {
          discount_limit_pct: 15,
          require_card_last4: false,
          quick_cash: [2000, 1000, 5000],
        },
      })
    ).toEqual({
      discountLimitPct: 15,
      requireCardLast4: false,
      quickCash: [1000, 2000, 5000],
      vatRegistered: true,
    })
  })

  it("fall back rather than half-apply a value of the wrong shape", () => {
    expect(
      eposSettingsFrom({
        epos: { discount_limit_pct: "lots", require_card_last4: "yes", quick_cash: ["£20", -5] },
      })
    ).toEqual(EPOS_DEFAULTS)
  })
})
