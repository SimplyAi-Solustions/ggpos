import { expect, test, type Page } from "@playwright/test"

import { buildCode, isValidCode } from "../packages/shared/src/sku"

/**
 * The Phase 1 counter, driven against the demo fixtures.
 *
 * `?demo=1` puts the built app into demo mode for the tab (it sticks in
 * sessionStorage), so this runs against an ordinary `pnpm --filter web build`
 * with no PocketBase behind it. `VITE_DEMO=1` at build time does the same
 * thing permanently.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

/** The SKU on the demo Charizard, built with a real check character. */
const DEMO_SKU = buildCode("single", "7F3K2")

async function signIn(page: Page) {
  await page.goto("/login?demo=1")
  await page.getByLabel("Email").fill(DEMO_EMAIL)
  await page.getByLabel("Password").fill(DEMO_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL(/\/counter$/)
  // The counter's chunk carries the shortcuts, the palette and the idle
  // timer, so nothing may be driven until its first screen is on.
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()
}

/** Below 900px the same action is a second, docked button. */
function primary(page: Page, name: string) {
  return page.getByRole("button", { name }).filter({ visible: true })
}

test.describe("the counter", () => {
  test("signs a staff member in with the demo account", async ({ page }) => {
    await signIn(page)
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()
    await expect(page.getByText("Demo", { exact: true })).toBeVisible()
  })

  test("sends an unsigned visit to sign-in and back again", async ({ page }) => {
    await page.goto("/counter/scan?demo=1")
    await expect(page).toHaveURL(/\/login/)

    await page.getByLabel("Email").fill(DEMO_EMAIL)
    await page.getByLabel("Password").fill(DEMO_PASSWORD)
    await page.getByRole("button", { name: "Sign in" }).click()

    await expect(page).toHaveURL(/\/counter\/scan/)
  })

  test("routes a scanned item SKU to its item page", async ({ page }) => {
    await signIn(page)
    await page.goto("/counter/scan")

    const field = page.getByTestId("scan-field")
    await field.fill(DEMO_SKU.display)
    await field.press("Enter")

    await expect(page).toHaveURL(new RegExp(`/counter/stock/${DEMO_SKU.encoded}$`))
    await expect(page.getByTestId("item-sku")).toHaveText(DEMO_SKU.display)
  })

  test("says what to do when a code is not a GG code", async ({ page }) => {
    await signIn(page)
    await page.goto("/counter/scan")

    const field = page.getByTestId("scan-field")
    await field.fill("NOTACODE")
    await field.press("Enter")

    await expect(
      page.getByText("Not a GG code. Check the label or type the SKU.")
    ).toBeVisible()
    await expect(page).toHaveURL(/\/counter\/scan/)
    await expect(page.getByText("Not recognised")).toBeVisible()
  })

  test("adds a Pokemon card found by set and number", async ({ page }) => {
    await signIn(page)
    await page.goto("/counter/stock/new")

    await page.getByLabel("Set and number").fill("sv151 199")
    const option = page.getByRole("option", { name: /Charizard ex/ })
    await expect(option).toBeVisible()
    await option.click()

    const preview = page.getByTestId("card-preview")
    await expect(preview).toContainText("Charizard ex")
    await expect(preview).toContainText("Scarlet & Violet 151")

    await page.getByRole("button", { name: "NM", exact: true }).click()
    await page.getByLabel("Cost").fill("180")
    await page.getByLabel("Price").fill("324.99")

    await primary(page, "Save item").click()

    await expect(page.getByRole("heading", { name: "Saved" })).toBeVisible()

    const code = await page.getByTestId("saved-sku").innerText()
    expect(isValidCode(code)).toBe(true)
    expect(code.startsWith("GGS-")).toBe(true)

    await primary(page, "Print label").click()
    await expect(page.getByText("Label queued")).toBeVisible()
  })

  test("opens the palette and carries a card into Add stock", async ({ page }) => {
    await signIn(page)

    await page.keyboard.press("ControlOrMeta+k")
    const palette = page.getByRole("dialog")
    await expect(palette).toBeVisible()

    await page.keyboard.type("charizard")
    await palette.getByText("Charizard ex").click()

    await expect(page).toHaveURL(/\/counter\/stock\/new\?.*set=sv151/)
    await expect(page.getByTestId("card-preview")).toContainText("Charizard ex")
    await expect(page.getByRole("combobox", { name: "Game" })).toContainText("Pokemon")
  })

  test("moves around on the desktop shortcuts", async ({ page }) => {
    await signIn(page)

    await page.keyboard.press("n")
    await expect(page).toHaveURL(/\/counter\/stock\/new/)
    await expect(page.getByRole("heading", { name: "Add stock" })).toBeVisible()

    // Typing in a field never fires a shortcut.
    await page.getByLabel("Set and number").fill("nnn")
    await expect(page).toHaveURL(/\/counter\/stock\/new/)

    await page.getByRole("heading", { name: "Add stock" }).click()
    await page.keyboard.press("s")
    await expect(page).toHaveURL(/\/counter\/scan/)
    // The scan field takes focus, so a wedge scanner needs no click.
    await expect(page.getByTestId("scan-field")).toBeFocused()

    await page.goto("/counter/stock")
    await expect(page.getByRole("heading", { name: "Stock" })).toBeVisible()
    await page.keyboard.press("b")
    await expect(page).toHaveURL(/\/counter\/trade/)
  })

  test("locks the counter after ten idle minutes", async ({ page }) => {
    await page.clock.install()
    await signIn(page)

    await page.clock.fastForward("11:00")

    const lock = page.getByRole("dialog", { name: "Locked" })
    await expect(lock).toBeVisible()
    await expect(lock).toContainText("DC")

    await page.getByLabel("Password").fill("wrong")
    await page.getByRole("button", { name: "Continue" }).click()
    await expect(page.getByText("That password did not match. Try again.")).toBeVisible()

    await page.getByLabel("Password").fill(DEMO_PASSWORD)
    await page.getByRole("button", { name: "Continue" }).click()
    await expect(lock).toBeHidden()
  })

  test("refuses to save without the fields the stock book needs", async ({ page }) => {
    await signIn(page)
    await page.goto("/counter/stock/new")

    await primary(page, "Save item").click()

    await expect(page.getByText("Choose the game this belongs to.")).toBeVisible()
    await expect(
      page.getByText("Search the set and number, or the card name, and choose one.")
    ).toBeVisible()
  })
})
