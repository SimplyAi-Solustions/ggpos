import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The admin's read and write of `settings`, against a stubbed collection API.
 *
 * The record holds the third-party API keys, the mail key and the VAPID
 * keys. None of them may reach the browser, so the request itself names the
 * fields it wants: what is never sent cannot leak, whatever a later
 * migration adds to the collection.
 */

const getList = vi.fn()
const update = vi.fn()

vi.mock("@/lib/pb", () => ({
  pb: {
    collection: (name: string) => ({
      getList: (page: number, perPage: number, options: unknown) =>
        getList(name, page, perPage, options),
      update: (id: string, body: unknown, options: unknown) =>
        update(name, id, body, options),
      getFullList: async () => [],
    }),
    authStore: { record: { id: "staff_demo" } },
  },
  pingPocketBase: async () => true,
}))

const { setDataMode } = await import("@/lib/api/mode")
const { getSettings, saveSettings, SETTINGS_FIELDS } = await import(
  "@/lib/api/settings"
)

/** What the server would send back if nobody asked it to hold anything back. */
const WHOLE_ROW = {
  id: "settings_1",
  cash_cap: 800_000,
  shop_name: "GG Entertainment",
  api_keys: { pricecharting: "pc_live_secret" },
  email_api_key: "re_live_secret",
  push_vapid_private_key: "vapid_secret",
}

describe("reading and writing the settings record", () => {
  beforeEach(() => {
    setDataMode(false)
    getList.mockReset()
    update.mockReset()
    getList.mockResolvedValue({ items: [WHOLE_ROW] })
    update.mockResolvedValue(WHOLE_ROW)
  })

  it("asks for the fields it shows, and no others", async () => {
    await getSettings()

    expect(getList).toHaveBeenCalledWith("settings", 1, 1, { fields: SETTINGS_FIELDS })
    expect(SETTINGS_FIELDS).not.toMatch(/key|secret/)
    expect(SETTINGS_FIELDS.split(",")).toContain("cash_cap")
  })

  it("names the same fields when it writes one back", async () => {
    await saveSettings("settings_1", { cash_cap: 500_000 })

    expect(update).toHaveBeenCalledWith(
      "settings",
      "settings_1",
      { cash_cap: 500_000 },
      { fields: SETTINGS_FIELDS }
    )
  })

  it("drops a key the server sent anyway", async () => {
    const row = (await getSettings()) as unknown as Record<string, unknown>

    expect(row.api_keys).toBeUndefined()
    expect(row.email_api_key).toBeUndefined()
    expect(row.push_vapid_private_key).toBeUndefined()
    expect(row.cash_cap).toBe(800_000)
  })

  it("says what to do when the shop has no settings row at all", async () => {
    getList.mockResolvedValue({ items: [] })

    await expect(getSettings()).rejects.toThrow(/Run the migrations first\./)
  })

  it("hands the demo counter a record with no key on it", async () => {
    setDataMode(true)

    const row = (await getSettings()) as unknown as Record<string, unknown>

    expect(Object.keys(row).join(" ")).not.toMatch(/key|secret/)
    expect(row.shop_name).toBe("GG Entertainment")
    expect(getList).not.toHaveBeenCalled()
  })
})
