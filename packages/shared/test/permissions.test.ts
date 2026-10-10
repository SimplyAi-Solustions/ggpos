import { describe, expect, it } from "vitest"

import {
  CAPABILITIES,
  CAPABILITY_LABELS,
  DEFAULT_PERMISSIONS,
  approverRole,
  can,
  pinProblem,
  resolvePermissions,
} from "../src/permissions"

describe("can", () => {
  it("ranks roles: staff < manager < admin", () => {
    expect(can("staff", "void_line")).toBe(true)
    expect(can("staff", "refund")).toBe(false)
    expect(can("manager", "refund")).toBe(true)
    expect(can("manager", "staff_manage")).toBe(false)
    expect(can("admin", "staff_manage")).toBe(true)
  })

  it("holds nothing for an unknown or missing role", () => {
    expect(can("owner", "void_line")).toBe(false)
    expect(can(undefined, "void_line")).toBe(false)
    expect(can("", "x_report")).toBe(false)
  })

  it("follows a table that lowers a capability", () => {
    const table = resolvePermissions({ z_report: "staff" })
    expect(can("staff", "z_report", table)).toBe(true)
    expect(can("staff", "z_report")).toBe(false)
  })
})

describe("resolvePermissions", () => {
  it("is the defaults when nothing is stored", () => {
    expect(resolvePermissions(null)).toEqual(DEFAULT_PERMISSIONS)
    expect(resolvePermissions("nonsense")).toEqual(DEFAULT_PERMISSIONS)
    expect(resolvePermissions([])).toEqual(DEFAULT_PERMISSIONS)
  })

  it("ignores unknown capabilities and roles", () => {
    const table = resolvePermissions({ refund: "owner", fly: "staff", no_sale: "staff" })
    expect(table.refund).toBe("manager")
    expect(table.no_sale).toBe("staff")
    expect("fly" in table).toBe(false)
  })

  it("never hands the settings or staff capabilities below admin", () => {
    const table = resolvePermissions({ settings_manage: "staff", staff_manage: "manager" })
    expect(table.settings_manage).toBe("admin")
    expect(table.staff_manage).toBe("admin")
  })

  it("covers every capability, each with a label", () => {
    const table = resolvePermissions({})
    for (const c of CAPABILITIES) {
      expect(table[c]).toBeDefined()
      expect(CAPABILITY_LABELS[c].length).toBeGreaterThan(0)
    }
  })
})

describe("approverRole", () => {
  it("is the role the table names", () => {
    expect(approverRole("refund")).toBe("manager")
    expect(approverRole("refund", resolvePermissions({ refund: "admin" }))).toBe("admin")
  })
})

describe("pinProblem", () => {
  it("accepts 4 and 6 digit PINs", () => {
    expect(pinProblem("2580")).toBeNull()
    expect(pinProblem("394817")).toBeNull()
  })

  it("refuses the wrong length or non-digits", () => {
    for (const pin of ["", "123", "12345", "1234567", "12a4", " 2580", 2580]) {
      expect(pinProblem(pin)).toBe("A PIN is 4 or 6 digits.")
    }
  })

  it("refuses runs and repeats, wrapping through zero", () => {
    for (const pin of ["0000", "1111", "1234", "4321", "123456", "654321", "7890", "8901", "0987", "999999"]) {
      expect(pinProblem(pin)).toBe("Choose a PIN that is not a run or a repeat, such as 1234 or 0000.")
    }
  })
})
