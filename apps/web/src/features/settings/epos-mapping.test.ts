import { describe, expect, it } from "vitest"

import {
  formToPatch,
  permissionsToStore,
  recordToForm,
  setPermission,
  validateSettings,
} from "@/features/settings/mapping"
import { DEMO_SETTINGS_RECORD } from "@/lib/api/demo/settings"
import { DEFAULT_PERMISSIONS } from "@gg/shared"

/**
 * The till's settings (`settings.epos`) through the Settings form and back.
 * Pounds on screen, pence stored; the permissions table stored as the rows
 * an admin moved off the defaults; nothing the form does not show is lost.
 */

const form = () => recordToForm(DEMO_SETTINGS_RECORD)

describe("the till's settings on the form", () => {
  it("reads the seed's values, in pounds and whole numbers", () => {
    const f = form()
    expect(f.discountLimitPct).toBe("10")
    expect(f.autoLockMinutes).toBe("5")
    expect(f.defaultFloat).toBe("100.00")
    expect(f.quickCash).toEqual([500, 1000, 2000, 5000])
    expect(f.requireCardLast4).toBe(true)
    expect(f.zRequiresCardTotal).toBe(true)
    expect(f.receiptFooter).toBe("Thank you for shopping with GG Entertainment.")
    expect(f.showPortalQr).toBe(true)
    expect(f.vatNumber).toBe("")
  })

  it("writes them back as pence, keeping what the form does not show", () => {
    const patch = formToPatch({
      ...form(),
      defaultFloat: "150.50",
      autoLockMinutes: "3",
      discountLimitPct: "15",
      quickCash: [2000, 1000],
      returnsPolicy: "  Bring it back within 14 days.  ",
      vatNumber: " GB123456789 ",
      eposStored: { ...form().eposStored, card_provider: "manual_tide" },
    })
    expect(patch.epos).toMatchObject({
      default_float: 15050,
      auto_lock_minutes: 3,
      discount_limit_pct: 15,
      quick_cash: [1000, 2000],
      card_provider: "manual_tide",
      receipt: { returns_policy: "Bring it back within 14 days." },
    })
    expect(patch.vat_number).toBe("GB123456789")
  })

  it("round-trips through a save without moving", () => {
    const again = recordToForm({ ...DEMO_SETTINGS_RECORD, ...formToPatch(form()) })
    expect(again).toEqual(form())
  })

  it("refuses an auto-lock past two hours, no quick cash, and a float that is not money", () => {
    const errors = validateSettings({
      ...form(),
      autoLockMinutes: "500",
      quickCash: [],
      defaultFloat: "a hundred",
      discountLimitPct: "150",
      vatNumber: "GB".padEnd(30, "1"),
    })
    expect(errors.autoLockMinutes).toContain("up to 120")
    expect(errors.quickCash).toBe("Choose at least one note for the cash step, for example £10 and £20.")
    expect(errors.defaultFloat).toBe("Enter an amount in pounds and pence, for example 12.50.")
    expect(errors.discountLimitPct).toBe("Enter a whole percent between 0 and 100.")
    expect(errors.vatNumber).toContain("at most 20 characters")
    // Zero minutes is allowed: the Lock key still works.
    expect(validateSettings({ ...form(), autoLockMinutes: "0" }).autoLockMinutes).toBeUndefined()
  })
})

describe("the permissions table", () => {
  it("stores only the rows moved off the defaults", () => {
    expect(permissionsToStore(DEFAULT_PERMISSIONS)).toEqual({})
    const moved = setPermission(DEFAULT_PERMISSIONS, "no_sale", "staff")
    expect(permissionsToStore(moved)).toEqual({ no_sale: "staff" })
  })

  it("never moves the two admin-only capabilities", () => {
    expect(setPermission(DEFAULT_PERMISSIONS, "staff_manage", "staff").staff_manage).toBe("admin")
    expect(
      permissionsToStore({ ...DEFAULT_PERMISSIONS, settings_manage: "staff" })
    ).toEqual({})
  })

  it("reads a stored change back onto the form", () => {
    const f = recordToForm({
      ...DEMO_SETTINGS_RECORD,
      epos: { ...DEMO_SETTINGS_RECORD.epos, permissions: { refund: "staff" } },
    })
    expect(f.permissions.refund).toBe("staff")
    expect(f.permissions.z_report).toBe("manager")
  })
})
