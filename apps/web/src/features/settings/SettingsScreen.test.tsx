import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

/**
 * Saving the Settings screen.
 *
 * The order matters: the settings record is an update and can be repeated
 * safely, while the rules write creates rows, and a row created twice is a
 * band nobody asked for. So the record goes first and the ids the rules
 * write hands back are taken into the form at once, which is what makes a
 * retry an update rather than a second create.
 */

const getSettings = vi.fn()
const listPricingRules = vi.fn()
const listGames = vi.fn()
const saveSettings = vi.fn()
const savePricingRules = vi.fn()

vi.mock("@/lib/api", () => ({
  getSettings: () => getSettings(),
  listPricingRules: () => listPricingRules(),
  listGames: () => listGames(),
  saveSettings: (id: string, patch: unknown) => saveSettings(id, patch),
  savePricingRules: (changes: unknown) => savePricingRules(changes),
}))

vi.mock("@/lib/auth", () => ({
  useStaff: () => ({ id: "staff_demo", email: "d@g.uk", name: "Demo", role: "admin" }),
}))

const { DEMO_RULE_ROWS, DEMO_SETTINGS_RECORD } = await import("@/lib/api/demo/settings")
const { SettingsScreen } = await import("@/features/settings/SettingsScreen")

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <SettingsScreen />
    </QueryClientProvider>
  )
}

async function saveButton() {
  return screen.getByRole("button", { name: /Save settings/ })
}

afterEach(cleanup)

describe("saving the settings", () => {
  beforeEach(() => {
    for (const spy of [getSettings, listPricingRules, listGames, saveSettings, savePricingRules]) {
      spy.mockReset()
    }
    getSettings.mockResolvedValue({ ...DEMO_SETTINGS_RECORD })
    listPricingRules.mockResolvedValue(DEMO_RULE_ROWS.map((row) => ({ ...row })))
    listGames.mockResolvedValue([
      { id: "game_pokemon", key: "pokemon", name: "Pokemon", enabled: true },
    ])
    saveSettings.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...DEMO_SETTINGS_RECORD,
      ...patch,
    }))
  })

  it("does not write a new rule when the settings record would not save", async () => {
    saveSettings.mockRejectedValue(new Error("Those settings did not save. Try again."))
    show()

    const cap = await screen.findByLabelText("Cash cap")
    await userEvent.clear(cap)
    await userEvent.type(cap, "5000")
    await userEvent.click(screen.getByRole("button", { name: "Add a rule" }))
    await userEvent.click(await saveButton())

    await screen.findByText("Those settings did not save. Try again.")
    expect(saveSettings).toHaveBeenCalledTimes(1)
    // The rules write never ran, so nothing was created to be created twice.
    expect(savePricingRules).not.toHaveBeenCalled()
    // And the row is still here, still unsaved, ready to go again.
    expect(screen.getAllByTestId("rule-row")).toHaveLength(DEMO_RULE_ROWS.length + 1)
  })

  it("takes the id a created rule comes back with, so a retry updates it", async () => {
    savePricingRules.mockImplementation(async () => [
      ...DEMO_RULE_ROWS.map((row) => ({ ...row })),
      {
        id: "rule_created_1",
        kind: "single",
        condition: "",
        band_min: 0,
        band_max: 0,
        cash_pct: 50,
        credit_pct: 65,
        rounding: 50,
        priority: 0,
        active: true,
      },
    ])
    show()

    await screen.findByLabelText("Cash cap")
    await userEvent.click(screen.getByRole("button", { name: "Add a rule" }))
    await userEvent.click(await saveButton())

    await waitFor(() => expect(savePricingRules).toHaveBeenCalledTimes(1))
    const first = savePricingRules.mock.calls[0]![0] as { id?: string }[]
    expect(first).toHaveLength(1)
    expect(first[0]!.id).toBeUndefined()

    // Change the same rule again: it is the server's row now, not a new one.
    const cash = screen.getAllByLabelText(/^Cash percent for the/)
    await userEvent.clear(cash[cash.length - 1]!)
    await userEvent.type(cash[cash.length - 1]!, "45")
    await userEvent.click(await saveButton())

    await waitFor(() => expect(savePricingRules).toHaveBeenCalledTimes(2))
    const second = savePricingRules.mock.calls[1]![0] as { id?: string }[]
    expect(second).toHaveLength(1)
    expect(second[0]!.id).toBe("rule_created_1")
  })

  it("saves the record before the rules, every time", async () => {
    const order: string[] = []
    saveSettings.mockImplementation(async () => {
      order.push("settings")
      return { ...DEMO_SETTINGS_RECORD }
    })
    savePricingRules.mockImplementation(async () => {
      order.push("rules")
      return DEMO_RULE_ROWS.map((row) => ({ ...row }))
    })
    show()

    await screen.findByLabelText("Cash cap")
    const cash = screen.getAllByLabelText(/^Cash percent for the/)
    await userEvent.clear(cash[0]!)
    await userEvent.type(cash[0]!, "35")
    await userEvent.click(await saveButton())

    await waitFor(() => expect(order).toEqual(["settings", "rules"]))
  })

  it("says the settings would not load when the games list is the thing that failed", async () => {
    listGames.mockRejectedValue(new Error("The games would not load."))
    show()

    expect(await screen.findByText("The games would not load.")).toBeTruthy()
    expect(screen.queryByText("Loading the settings.")).toBeNull()
  })
})
