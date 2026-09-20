import { expect, test, type Page } from "@playwright/test"

/**
 * The admin Settings screen, driven against the demo fixtures at both
 * widths. The demo settings and pricing rules live in memory for the tab,
 * like every other demo store, so a save is checked by leaving the screen
 * and coming back rather than by reloading the page.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

/** The top band: everything at £50 and over. */
const TOP_BAND = "Single, £50.00 and up"

async function signIn(page: Page) {
  await page.goto("/login?demo=1")
  await page.getByLabel("Email").fill(DEMO_EMAIL)
  await page.getByLabel("Password").fill(DEMO_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()
}

/** Below 900px the same action is a second, docked button. */
function primary(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true }).filter({ visible: true })
}

/** The palette is the one way between screens that works at both widths. */
async function go(page: Page, action: string) {
  await page.keyboard.press("ControlOrMeta+k")
  const palette = page.getByRole("dialog")
  await expect(palette).toBeVisible()
  await palette.getByText(action, { exact: true }).click()
  await expect(palette).toBeHidden()
}

/**
 * The matrix is a table from 900px and a list of summaries with an edit
 * sheet below it, so one helper puts a percentage in whichever is on screen.
 */
async function setRuleCash(page: Page, band: string, value: string) {
  const inline = page
    .getByLabel(`Cash percent for the ${band} rule`)
    .filter({ visible: true })
  if ((await inline.count()) > 0) {
    await inline.fill(value)
    return
  }
  await page
    .getByTestId("rule-row-small")
    .filter({ hasText: band.replace("Single, ", "") })
    .getByRole("button", { name: "Edit" })
    .click()
  const sheet = page.getByRole("dialog")
  await expect(sheet).toBeVisible()
  await sheet.getByLabel("Cash", { exact: true }).fill(value)
  await sheet.getByRole("button", { name: "Done" }).click()
  await expect(sheet).toBeHidden()
}

test.describe("settings", () => {
  test("prices a card off the rules on the page, before they are saved", async ({
    page,
  }) => {
    await signIn(page)
    await go(page, "Settings")
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible()

    // The seed: a £100 near-mint single is 60 percent cash, 75 percent credit.
    await expect(page.getByTestId("preview-rule")).toHaveText(TOP_BAND)
    await expect(page.getByTestId("preview-cash")).toHaveText("£60.00")
    await expect(page.getByTestId("preview-credit")).toHaveText("£75.00")

    // An unsaved percentage moves the preview, because both run the shared
    // evaluator over the rules as they stand in the form.
    await setRuleCash(page, TOP_BAND, "70")
    await expect(page.getByTestId("preview-cash")).toHaveText("£70.00")
    await expect(page.getByTestId("dirty-hint")).toBeVisible()

    await primary(page, "Save settings").click()
    await expect(page.getByTestId("settings-saved")).toBeVisible()
    await expect(page.getByTestId("dirty-hint")).toBeHidden()

    // And it is still 70 when the screen is opened again.
    await go(page, "Stock")
    await expect(page.getByRole("heading", { name: "Stock" })).toBeVisible()
    await go(page, "Settings")
    await expect(page.getByTestId("preview-cash")).toHaveText("£70.00")
  })

  test("takes pounds, keeps pence, and puts a discard back", async ({ page }) => {
    await signIn(page)
    await go(page, "Settings")

    // £8,000 in the record reads as pounds and pence on screen.
    const cap = page.getByLabel("Cash cap")
    await expect(cap).toHaveValue("8000.00")

    await cap.fill("5000")
    await expect(page.getByTestId("dirty-hint")).toBeVisible()
    await page.getByRole("button", { name: "Discard" }).click()
    await expect(cap).toHaveValue("8000.00")
    await expect(page.getByTestId("dirty-hint")).toBeHidden()

    // A saved amount round-trips through pence and back.
    await cap.fill("5000")
    await primary(page, "Save settings").click()
    await expect(page.getByTestId("settings-saved")).toBeVisible()
    await expect(page.getByLabel("Cash cap")).toHaveValue("5000.00")
  })

  test("says what to do about an amount that is not money", async ({ page }) => {
    await signIn(page)
    await go(page, "Settings")

    await page.getByLabel("Cash cap").fill("eight thousand")
    await primary(page, "Save settings").click()

    await expect(
      page.getByText("Enter an amount in pounds and pence, for example 12.50.")
    ).toBeVisible()
    await expect(page.getByTestId("settings-saved")).toBeHidden()
  })

  test("reorders the price sources", async ({ page }) => {
    await signIn(page)
    await go(page, "Settings")

    const rows = page.getByTestId("card-sources-row")
    await expect(rows.first()).toContainText("UK sold comp")
    await expect(rows.nth(1)).toContainText("eBay UK asking")

    await page
      .getByRole("button", { name: "Move Cardmarket, EUR up in the card order" })
      .click()
    await expect(rows.nth(1)).toContainText("Cardmarket")
    await expect(rows.nth(2)).toContainText("eBay UK asking")
    await expect(page.getByTestId("dirty-hint")).toBeVisible()
  })

  test("suggests a sell price from the markup bands", async ({ page }) => {
    await signIn(page)
    await go(page, "Settings")

    const preview = page.getByTestId("sell-preview")
    // 10 percent on £3.00 is £3.30, which rounds up to the next .49.
    await expect(preview).toContainText("£3.49")
    // 5 percent on £12.00 is £12.60, which rounds up to the next .99.
    await expect(preview).toContainText("£12.99")
  })

  test("is one line for a staff member", async ({ page }) => {
    await page.addInitScript(() => {
      window.sessionStorage.setItem("gg-demo", "1")
      window.localStorage.setItem(
        "gg-demo-staff",
        JSON.stringify({
          id: "staff_demo",
          email: "demo@ggentertainment.co.uk",
          name: "Demo Counter",
          role: "staff",
          active: true,
        })
      )
    })
    await page.goto("/counter/settings?demo=1")

    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible()
    await expect(
      page.getByText("Settings are for admins. Ask Richard if something needs changing.")
    ).toBeVisible()
    await expect(page.getByTestId("rules-matrix")).toHaveCount(0)
  })

  test("never puts an API key on the page", async ({ page }) => {
    await signIn(page)
    await go(page, "Settings")

    await expect(
      page.getByText("API keys for the price sources are held on the server")
    ).toBeVisible()
    await expect(page.getByLabel(/api key/i)).toHaveCount(0)
    await expect(page.getByLabel(/vapid/i)).toHaveCount(0)
  })
})
