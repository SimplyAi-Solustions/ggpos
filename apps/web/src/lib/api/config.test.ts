import { beforeAll, describe, expect, it } from "vitest"

import { setDataMode } from "@/lib/api/mode"
import { getCounterConfig, tiersFrom } from "@/lib/api/config"
import { DEMO_SETTINGS } from "@/lib/api/demo/store"
import type { VaultConfig } from "@/lib/api/types"

/**
 * `settings`, `pricing_rules` and the loyalty collections are admin-only, so
 * everything the counter reads out of them arrives through one staff-readable
 * config route. These check the slice the Sell and Cash screens take from it.
 */
describe("the counter's configuration", () => {
  beforeAll(() => {
    setDataMode(true)
  })

  it("takes the variance alert from the shop's settings, with no default of its own", async () => {
    const config = await getCounterConfig()
    expect(config.cashVarianceAlert).toBe(DEMO_SETTINGS.cash_variance_alert)
    expect(config.cashCap).toBe(DEMO_SETTINGS.cash_cap)
  })

  it("reads zero when no alert is set, which is how the close route reads it", () => {
    const bare: VaultConfig = {
      settings: {},
      pricing_rules: [],
      loyalty: { programme: null, rules: [], tiers: [] },
    }
    expect(bare.settings.cash_variance_alert ?? 0).toBe(0)
  })

  it("carries the programme and the tiers the points preview needs", async () => {
    const config = await getCounterConfig()
    expect(config.loyalty.programme.earnPerPoundSales).toBe(10)
    // The ladder, then the one paid plan: a membership pins "Guild Pass"
    // rather than any number of points earning it.
    expect(config.loyalty.tiers.map((tier) => tier.name)).toEqual([
      "Member",
      "Regular",
      "Legend",
      "Guild Pass",
    ])
  })

  it("keeps a tier's percent-off perk, which is what a sale applies", async () => {
    const config = await getCounterConfig()
    const legend = config.loyalty.tiers.find((tier) => tier.name === "Legend")
    expect(legend?.perks).toContainEqual({
      type: "percent_off",
      value: 10,
      scope: ["single", "graded", "retro", "sealed", "accessory", "other"],
    })
  })

  it("drops a perk shape the shared evaluator does not know, rather than half-reading it", () => {
    const config: VaultConfig = {
      settings: {},
      pricing_rules: [],
      loyalty: {
        programme: null,
        rules: [],
        tiers: [
          {
            id: "tier_odd",
            name: "Odd",
            threshold_points: 0,
            sort: 10,
            // The pre-fix seed's snake_case, and a scope that is not a list.
            perks: [
              { type: "percent_off", value: 5, scope: "all" },
              { type: "free_event_entries", value: 2, per_month: true },
              { type: "points_multiplier", value: 2 },
            ],
            paid_plan: false,
          },
        ],
      },
    }
    expect(tiersFrom(config)[0]?.perks).toEqual([
      { type: "points_multiplier", value: 2 },
    ])
  })

  it("sorts the tiers the way the shop ordered them", () => {
    const config: VaultConfig = {
      settings: {},
      pricing_rules: [],
      loyalty: {
        programme: null,
        rules: [],
        tiers: [
          { id: "c", name: "Legend", sort: 30, perks: [] },
          { id: "a", name: "Member", sort: 10, perks: [] },
          { id: "b", name: "Regular", sort: 20, perks: [] },
        ],
      },
    }
    expect(tiersFrom(config).map((tier) => tier.name)).toEqual([
      "Member",
      "Regular",
      "Legend",
    ])
  })
})
