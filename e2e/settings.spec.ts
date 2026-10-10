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

  test("is one page title and a heading per section", async ({ page }) => {
    await signIn(page)
    await go(page, "Settings")

    // One Anton line per screen, and the sections under it are real
    // headings rather than spans that look like them.
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1)
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings")

    for (const section of [
      "Buy-in defaults",
      "Pricing rules",
      "Sell price",
      "Limits",
      "Till",
      "Permissions",
      "Receipts",
      "Shop",
      "Receipt terms",
      "Price sources",
      "Tills",
      "Printers",
    ]) {
      await expect(page.getByRole("heading", { level: 2, name: section, exact: true })).toHaveCount(1)
    }
    const headings = await page.getByRole("heading", { level: 2 }).count()
    expect(headings).toBeGreaterThanOrEqual(12)
  })

  test("offers Settings in the palette to an admin and not to anybody else", async ({
    page,
  }) => {
    await signIn(page)
    await page.keyboard.press("ControlOrMeta+k")
    const palette = page.getByRole("dialog")
    await expect(palette).toBeVisible()
    await expect(palette.getByText("Settings", { exact: true })).toBeVisible()
    await expect(palette.getByText("Stock count", { exact: true })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(palette).toBeHidden()

    await page.evaluate(() => {
      const raw = window.localStorage.getItem("gg-demo-staff")
      if (!raw) return
      window.localStorage.setItem(
        "gg-demo-staff",
        JSON.stringify({ ...JSON.parse(raw), role: "staff" })
      )
    })
    await page.reload()
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()

    await page.keyboard.press("ControlOrMeta+k")
    await expect(palette).toBeVisible()
    // Counts are for everybody; the admin screen is not offered to staff.
    await expect(palette.getByText("Stock count", { exact: true })).toBeVisible()
    await expect(palette.getByText("Settings", { exact: true })).toHaveCount(0)
  })

  test("never puts an API key on the page", async ({ page }) => {
    await signIn(page)
    await go(page, "Settings")

    await expect(
      page.getByText("API keys for the price sources are held on the server")
    ).toBeVisible()
    await expect(page.getByLabel(/api key/i)).toHaveCount(0)
    await expect(page.getByLabel(/vapid/i)).toHaveCount(0)
    // Card payments are keyed on the Tide reader by hand: nothing to pair,
    // and no key anywhere on the page.
    await expect(page.getByTestId("card-provider")).toHaveText("Tide Card Reader, keyed by hand.")
    await expect(page.getByLabel(/sumup/i)).toHaveCount(0)
    await expect(page.getByText(/SumUp/)).toHaveCount(0)
  })

  // --- The till (Phase 8) ---
  test("saves the till's settings with the rest", async ({ page }) => {
    await signIn(page)
    await go(page, "Settings")

    await expect(page.getByLabel("Discount limit")).toHaveValue("10")
    await expect(page.getByLabel("Auto-lock")).toHaveValue("5")
    await expect(page.getByLabel("Default float")).toHaveValue("100.00")

    await page.getByLabel("Discount limit").fill("15")
    await page.getByLabel("Auto-lock").fill("200")
    await page.getByRole("group", { name: "Quick cash notes" }).getByRole("button", { name: "£50" }).click()
    await primary(page, "Save settings").click()
    await expect(
      page.getByText("Enter the minutes as a whole number up to 120, for example 5. Zero never locks on a timer.")
    ).toBeVisible()

    await page.getByLabel("Auto-lock").fill("3")
    await page.getByLabel("VAT number").fill("GB123456789")
    await page.getByLabel("Footer").fill("Thanks for coming in.")
    await primary(page, "Save settings").click()
    await expect(page.getByTestId("settings-saved")).toBeVisible()

    await go(page, "Stock")
    await expect(page.getByRole("heading", { name: "Stock" })).toBeVisible()
    await go(page, "Settings")
    await expect(page.getByLabel("Discount limit")).toHaveValue("15")
    await expect(page.getByLabel("Auto-lock")).toHaveValue("3")
    await expect(page.getByLabel("VAT number")).toHaveValue("GB123456789")
    await expect(page.getByLabel("Footer")).toHaveValue("Thanks for coming in.")
    await expect(
      page.getByRole("group", { name: "Quick cash notes" }).getByRole("button", { name: "£50" })
    ).toHaveAttribute("aria-pressed", "false")
  })

  test("keeps settings and staff with an admin in the permissions table", async ({ page }) => {
    await signIn(page)
    await go(page, "Settings")

    const table = page.getByTestId("permissions-table")
    await table.scrollIntoViewIfNeeded()
    await expect(table.getByTestId("permission-settings_manage")).toContainText("Admin")
    await expect(table.getByTestId("permission-settings_manage")).toContainText("Fixed")
    await expect(table.getByTestId("permission-staff_manage").getByRole("combobox")).toHaveCount(0)

    const noSale = table.getByRole("combobox", { name: "Lowest role for open the drawer with no sale" })
    await expect(noSale).toContainText("Manager")
    await noSale.click()
    await page.getByRole("option", { name: "Staff" }).click()
    await expect(noSale).toContainText("Staff")
    await primary(page, "Save settings").click()
    await expect(page.getByTestId("settings-saved")).toBeVisible()
  })

  test("registers this browser as a till, and revokes a device", async ({ page }) => {
    await signIn(page)
    await go(page, "Settings")
    const tills = page.getByTestId("tills-section")
    await tills.scrollIntoViewIfNeeded()

    // The demo browser starts as a till.
    await expect(tills.getByTestId("this-browser")).toContainText("This browser is a till on Counter")
    await expect(tills.getByTestId("this-browser-check")).toHaveText("The server knows this device.")

    await tills.getByRole("button", { name: "Forget this device" }).click()
    await expect(tills.getByText("This browser is not a till.")).toBeVisible()

    await tills.getByRole("button", { name: "Register this device" }).click()
    const sheet = page.getByRole("dialog", { name: "Register this device" })
    await expect(sheet).toBeVisible()
    await sheet.getByRole("button", { name: "Register this device" }).click()
    await expect(sheet.getByText("Give this device a name, for example Counter Mac.")).toBeVisible()
    await sheet.getByLabel("Name", { exact: true }).fill("Counter Mac")
    await sheet.getByRole("button", { name: "Register this device" }).click()

    const stepUp = page.getByRole("dialog", { name: "Confirm your password to continue" })
    await expect(stepUp).toBeVisible()
    await stepUp.getByLabel("Password").fill(DEMO_PASSWORD)
    await stepUp.getByRole("button", { name: "Continue" }).click()

    await expect(sheet).toBeHidden()
    await expect(tills.getByTestId("this-browser")).toContainText("as Counter Mac")
    const devices = tills.getByTestId("device-row")
    await expect(devices.filter({ hasText: "Counter Mac" })).toContainText("This browser")

    // Revoking the old demo till asks once more, then marks it.
    const old = devices.filter({ hasText: "Demo till" })
    await old.getByRole("button", { name: "Revoke Demo till" }).click()
    await old.getByRole("button", { name: "Revoke Demo till" }).click()
    await expect(old).toContainText("Revoked")
  })

  test("adds, renames and switches off a register", async ({ page }) => {
    await signIn(page)
    await go(page, "Settings")
    const tills = page.getByTestId("tills-section")
    await tills.scrollIntoViewIfNeeded()

    await tills.getByRole("button", { name: "Add a register" }).click()
    const sheet = page.getByRole("dialog", { name: "Add a register" })
    await sheet.getByLabel("Name", { exact: true }).fill("counter")
    await sheet.getByRole("button", { name: "Add register" }).click()
    await expect(
      sheet.getByText("There is already a register called counter. Choose another name.")
    ).toBeVisible()
    await sheet.getByLabel("Name", { exact: true }).fill("Back room")
    await sheet.getByRole("button", { name: "Add register" }).click()
    await expect(sheet).toBeHidden()
    await expect(tills.getByTestId("register-row")).toHaveCount(2)

    await tills.getByRole("button", { name: "Rename Back room" }).click()
    const rename = page.getByRole("dialog", { name: "Rename Back room" })
    await rename.getByLabel("Name", { exact: true }).fill("Events table")
    await rename.getByRole("button", { name: "Save name" }).click()
    await expect(rename).toBeHidden()

    const row = tills.getByTestId("register-row").filter({ hasText: "Events table" })
    await row.getByRole("button", { name: "Switch off Events table" }).click()
    await expect(row).toContainText("Switched off")
  })

  test("shows a manager the Tills and nothing else", async ({ page }) => {
    await page.goto("/login?demo=1")
    await page.getByLabel("Email").fill("mo@ggentertainment.co.uk")
    await page.getByLabel("Password").fill("ggvault-manager")
    await page.getByRole("button", { name: "Sign in" }).click()
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()
    await go(page, "Settings")

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings")
    await expect(page.getByTestId("tills-section")).toBeVisible()
    await expect(page.getByTestId("rules-matrix")).toHaveCount(0)
    await expect(page.getByTestId("permissions-table")).toHaveCount(0)
    // A manager registers devices but does not rename registers.
    await expect(page.getByRole("button", { name: "Add a register" })).toHaveCount(0)
  })
})
