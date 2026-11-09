import { describe, expect, it } from "vitest"

import type { EposItem } from "../api"
import { eposCopy } from "./epos-view"

const base: EposItem = { status: "none", message: "Not on Epos Now yet.", epos_product_id: null, synced_at: null, sold_on_till: null }

describe("eposCopy", () => {
  it("names each state in plain words", () => {
    const synced = eposCopy({ ...base, status: "synced", epos_product_id: 777, synced_at: "2026-11-09 15:00:00.000Z" }, false)
    expect(synced.title).toBe("On Epos Now")
    expect(synced.line).toMatch(/^Synced .+, product 777$/)
    expect(eposCopy({ ...base, status: "waiting", message: "Waiting to sync to Epos Now." }, false).title).toBe("Waiting to sync")
    expect(eposCopy({ ...base, status: "needs_check", message: "x" }, false)).toMatchObject({ title: "Needs a check", tone: "alert" })
    expect(eposCopy(base, false).title).toBe("Not on Epos Now")
    expect(eposCopy(undefined, true).tone).toBe("off")
  })
})
