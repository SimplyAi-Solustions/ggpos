import { readFileSync } from "node:fs"

import { expect, test, type Page } from "@playwright/test"

/**
 * Reports, Excel and VAT (docs/api-contract-launch.md, section 3), driven
 * against the demo fixtures at both widths: the dashboard first under
 * Reports with its Excel download and its drill into the Sales report, and
 * VAT switched on with a branch at 5 percent, a sale of stock filed there
 * charged at 5 percent, and the VAT return showing it.
 *
 * The demo shop lives in memory for the tab, so the VAT test moves between
 * screens with the command palette rather than by loading an address.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

/** £1,234.56, and never 45p or a bare number. */
const MONEY = /^-?£\d{1,3}(,\d{3})*\.\d{2}$/

async function signIn(page: Page) {
  await page.goto("/login?demo=1")
  await page.getByLabel("Email").fill(DEMO_EMAIL)
  await page.getByLabel("Password").fill(DEMO_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()
}

/** The palette is the one way between screens that works at both widths. */
async function go(page: Page, action: string) {
  await page.keyboard.press("ControlOrMeta+k")
  const palette = page.getByRole("dialog")
  await expect(palette).toBeVisible()
  await palette.getByText(action, { exact: true }).click()
  await expect(palette).toBeHidden()
}

/** Below 900px the same action is a second, docked button. */
function primary(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true }).filter({ visible: true })
}

/** Click a download button and hand back the file it gave. */
async function download(page: Page, click: () => Promise<void>) {
  const waiting = page.waitForEvent("download")
  await click()
  const file = await waiting
  const path = await file.path()
  return { name: file.suggestedFilename(), bytes: readFileSync(path) }
}

/** An .xlsx is a zip: "PK" first. */
function isWorkbook(bytes: Buffer): boolean {
  return bytes.length > 500 && bytes.subarray(0, 2).toString("latin1") === "PK"
}

test.describe("the reports dashboard", () => {
  test("leads Reports with sales and profit, and downloads as Excel and CSV", async ({ page }) => {
    await signIn(page)
    await go(page, "Reports")
    await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible()
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1)

    const figures = page.getByTestId("dashboard-kpis")
    await expect(figures).toBeVisible()
    for (const key of ["net", "profit", "cost", "vat", "average", "discounts", "refunds"]) {
      await expect(page.getByTestId(`dashboard-${key}`)).toHaveText(MONEY)
    }
    await expect(page.getByTestId("dashboard-margin_pct")).toHaveText(/^-?\d+(\.\d)?%$/)
    // Each figure says how it moved against the period before.
    await expect(figures).toContainText(/No change|[+-]£|[+-]\d/)
    await expect(page.getByTestId("dashboard-range")).toContainText("against")

    await expect(page.getByTestId("dashboard-category")).toContainText("Trading cards")
    await expect(page.getByTestId("dashboard-top-items")).toBeVisible()
    await expect(page.getByTestId("dashboard-payments")).toContainText("Card")
    await expect(page.getByTestId("dashboard-stock-cost")).toHaveText(MONEY)
    // The nine reports are still all there, under it.
    await expect(page.getByTestId("report-list").getByRole("link")).toHaveCount(9)

    const excel = await download(page, () => primary(page, "Export Excel").click())
    expect(excel.name).toMatch(/^gg-vault-dashboard-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.xlsx$/)
    expect(isWorkbook(excel.bytes)).toBe(true)

    const csv = await download(page, () => page.getByRole("button", { name: "Export CSV", exact: true }).click())
    expect(csv.name).toMatch(/^gg-vault-dashboard-.*\.csv$/)
    expect(csv.bytes.toString("utf8")).toContain("Day,Net sales,Cost,Profit")
  })

  test("drills from a branch into the Sales report by category", async ({ page }) => {
    await signIn(page)
    await go(page, "Reports")
    await page
      .getByTestId("dashboard-category")
      .getByTestId("dashboard-drill")
      .filter({ visible: true })
      .filter({ hasText: "Trading cards" })
      .click()
    await expect(page.getByRole("heading", { level: 1, name: "Sales" })).toBeVisible()
    await expect(page.getByTestId("report-trail")).toContainText("Trading cards")
    await expect(page.getByTestId("report-table")).toContainText("Pokémon")

    // Every report downloads as Excel beside its CSV.
    const excel = await download(page, () => page.getByRole("button", { name: "Export Excel", exact: true }).click())
    expect(excel.name).toMatch(/^gg-vault-sales-.*\.xlsx$/)
    expect(isWorkbook(excel.bytes)).toBe(true)
  })
})

test.describe("VAT", () => {
  test("switched on with a branch at 5%, a sale is charged 5% and the VAT return shows it", async ({ page }) => {
    await signIn(page)

    // --- Settings, VAT ------------------------------------------------------
    await go(page, "Settings")
    const vat = page.getByTestId("vat-settings")
    await vat.scrollIntoViewIfNeeded()
    await expect(page.getByTestId("vat-treatments")).toContainText("Margin scheme is for second-hand goods")
    await vat.getByRole("switch", { name: "VAT registered" }).click()
    await primary(page, "Save settings").click()
    await expect(page.getByText("Enter the date VAT registration starts")).toBeVisible()
    await page.getByLabel("VAT number").fill("GB123456789")
    await page.getByLabel("Registered from").fill("2026-01-01")
    await primary(page, "Save settings").click()
    await expect(page.getByTestId("settings-saved")).toBeVisible()

    // --- A branch at 5% ---------------------------------------------------
    const branch = page.locator('[data-testid="category-row"][data-name="Drinks and snacks"]').first()
    await branch.scrollIntoViewIfNeeded()
    await branch.getByRole("button", { name: "More for Drinks and snacks" }).click()
    await page.getByRole("menuitem", { name: "Defaults and picture", exact: true }).click()
    const defaults = page.getByRole("form", { name: "Defaults for Drinks and snacks" })
    await defaults.getByRole("combobox", { name: "VAT treatment" }).click()
    await page.getByRole("option", { name: "Reduced rate, 5%" }).click()
    await defaults.getByRole("button", { name: "Save defaults" }).click()
    await expect(defaults).toBeHidden()

    // --- Stock filed there takes the branch's treatment ---------------------
    await go(page, "Add stock")
    await expect(page.getByRole("heading", { name: "Add stock" })).toBeVisible()
    await page.getByRole("button", { name: "Choose a branch" }).click()
    const picker = page.getByTestId("category-picker")
    await picker
      .getByTestId("category-picker-rows")
      .getByRole("button")
      .filter({ has: page.getByText("Drinks and snacks", { exact: true }) })
      .click()
    await picker.getByRole("button", { name: "Choose this branch" }).click()
    await expect(page.getByRole("combobox", { name: "VAT" })).toContainText("Reduced rate, 5%")
    await page.getByRole("combobox", { name: "Game" }).click()
    await page.getByRole("option", { name: "Pokemon" }).click()
    await page.getByLabel("Title").fill("Fizzy Pikachu Can")
    await page.getByLabel("Cost").fill("0.40")
    await page.getByLabel("Price").fill("10.50")
    await primary(page, "Save item").click()
    await expect(page.getByRole("heading", { name: "Saved" })).toBeVisible()
    const sku = (await page.getByTestId("saved-sku").innerText()).trim()

    // --- Sold at the till -------------------------------------------------
    await go(page, "Till")
    await expect(page.getByTestId("till")).toBeVisible()
    const tab = page.getByRole("tab", { name: /^(Items|Pay|Done)$/ })
    if (await tab.isVisible()) await tab.click()
    await page.getByTestId("till-scan-field").fill(sku)
    await page.getByTestId("till-scan-field").press("Enter")
    await expect(page.getByText("Fizzy Pikachu Can added")).toBeVisible()
    await page.getByTestId("till-pay").filter({ visible: true }).click()
    await expect(page.getByTestId("till-to-pay")).toHaveText("£10.50")
    if (await tab.isVisible()) await tab.click()
    await page.getByRole("button", { name: "Card", exact: true }).click()
    await page.getByLabel("Last four digits").fill("4242")
    await page.getByTestId("till-card-approved").click()
    await expect(page.getByTestId("till-done")).toBeVisible()

    // --- The VAT return ---------------------------------------------------
    await go(page, "Reports")
    await page.getByTestId("vat-list").getByRole("link", { name: /VAT return/ }).click()
    await expect(page.getByRole("heading", { level: 1, name: "VAT return" })).toBeVisible()
    await expect(page.getByTestId("vat-boxes")).toContainText("VAT due on sales")
    // £10.50 at 5% is £0.50 of VAT inside it, £10.00 without.
    const reduced = page.getByTestId("vat-by-rate")
    await expect(reduced).toContainText("Reduced 5%")
    await expect(reduced).toContainText("£10.50")
    await expect(reduced).toContainText("£0.50")
    await expect(page.getByTestId("vat-rows")).toContainText("Fizzy Pikachu Can")
    await expect(page.getByText("GG Vault does not file the return.")).toBeVisible()

    const excel = await download(page, () => primary(page, "Export Excel").click())
    expect(excel.name).toMatch(/^gg-vault-vat-return-\d{4}-Q[1-4]\.xlsx$/)
    expect(isWorkbook(excel.bytes)).toBe(true)

    // A quarter before registration answers every box 0, with the reason.
    await page.getByTestId("vat-period").click()
    await page.getByRole("option").last().click()
    await expect(page.getByTestId("vat-note")).toContainText("every box is 0")
  })
})
