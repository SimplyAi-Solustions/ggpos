import { describe, expect, it, vi } from "vitest"

import { refusalOrFallback } from "@/lib/api/refusal"

/**
 * What comes back from a redemption, and what the customer is told when it
 * does not.
 *
 * The points have already gone by the time the response arrives, so the two
 * things worth testing without a browser are that nothing but the
 * contract's `{ voucher }` is accepted as somebody's voucher, and that a
 * refusal reaches the sheet as the sentence it was written as.
 */

const { send } = vi.hoisted(() => ({ send: vi.fn() }))

vi.mock("@/lib/pb-customer", () => ({ pbCustomer: { send } }))
// The real one would answer out of the demo fixtures instead of the route.
vi.mock("@/lib/api/mode", () => ({ isDemo: () => false }))

const { redeemReward } = await import("@/lib/api/guild")
const { demoRedeem } = await import("@/lib/api/demo/portal-guild")

const VOUCHER = {
  id: "red_1",
  number: "GG-V-000008",
  code: "GGV7QB2MW",
  reward: { name: "Free booster pack", type: "free_item" as const, value: 0 },
  status: "issued" as const,
  expires_at: "2026-12-10T00:00:00.000Z",
  created: "2026-09-11T00:00:00.000Z",
}

const NOT_AS_EXPECTED =
  "The voucher did not come back as expected. Check My vouchers before trying again."

describe("redeemReward", () => {
  it("posts to the reward's own redeem route and takes the voucher off the body", async () => {
    send.mockResolvedValueOnce({ voucher: VOUCHER })
    await expect(redeemReward("reward_booster")).resolves.toEqual(VOUCHER)
    expect(send).toHaveBeenCalledWith("/api/vault/rewards/reward_booster/redeem", {
      method: "POST",
    })
  })

  it("refuses to read a body that is not the contract's", async () => {
    // A bare row, an older key, or nothing at all: the points are gone
    // either way, so the customer is sent to the list that holds the real
    // voucher rather than shown a half-read object as theirs.
    for (const body of [VOUCHER, { redemption: VOUCHER }, {}, null]) {
      send.mockResolvedValueOnce(body)
      await expect(redeemReward("reward_booster")).rejects.toThrow(NOT_AS_EXPECTED)
    }
  })

  it("says so in a sentence the sheet can show", () => {
    send.mockResolvedValueOnce({})
    return redeemReward("reward_booster").catch((error: unknown) => {
      expect(refusalOrFallback(error, "That did not go through.")).toBe(
        NOT_AS_EXPECTED
      )
    })
  })
})

describe("a redemption the shop refuses", () => {
  it("throws the route's own sentence, and the screen shows it", () => {
    // `reward_playmat` is the demo's race: the catalogue offers it and the
    // last one goes before the press lands.
    try {
      demoRedeem("reward_playmat")
      throw new Error("The demo let a sold-out reward through.")
    } catch (error) {
      expect(refusalOrFallback(error, "That did not go through.")).toBe(
        "That one has gone. Pick another reward."
      )
    }
  })

  it("falls back to the screen's own line when the failure has no words", () => {
    expect(refusalOrFallback(new TypeError("fetch failed"), "Try again.")).toBe(
      "Try again."
    )
  })
})
