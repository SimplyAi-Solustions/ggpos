import { expect, test, type Page } from "@playwright/test"

/**
 * Cashing up, against the demo till at both widths.
 *
 * The demo till starts open on a morning's trade: six sales, one cash
 * refund, a £65.00 buy-in payout and a £100.00 float, so the drawer should
 * hold £52.48 and the card on the till comes to £132.43. Yesterday's X 86
 * and Z 41 are in the history, so the next X is 87 and the next Z is 42.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

async function signIn(page: Page) {
  await page.goto("/login?demo=1")
  await page.getByLabel("Email").fill(DEMO_EMAIL)
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()
}

async function go(page: Page, action: string) {
  await page.keyboard.press("ControlOrMeta+k")
  // The palette by name: the lock screen is a dialog of its own.
  const palette = page.getByRole("dialog", { name: "Commands and catalogue search" })
  await expect(palette).toBeVisible()
  await palette.getByText(action, { exact: true }).click()
  await expect(palette).toBeHidden()
}

/** Below 900px a screen's block is docked; take whichever is on screen. */
function primary(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true }).filter({ visible: true })
}

/** £109.60 in notes and coins. */
async function countDrawer(page: Page) {
  const counts: Record<string, string> = {
    "2000": "3",
    "1000": "2",
    "500": "4",
    "100": "6",
    "50": "3",
    "20": "8",
    "10": "5",
  }
  for (const [value, count] of Object.entries(counts)) {
    await page.locator(`#z-${value}`).fill(count)
  }
}

test.describe("cashing up", () => {
  test("shows the open till and runs an X report laid out like the receipt", async ({ page }) => {
    await signIn(page)
    await go(page, "Cash up")

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Cash up")
    await expect(page.getByTestId("till-state")).toContainText("Open since 09:00")
    await expect(page.getByTestId("till-state")).toContainText("£100.00 float")
    await expect(page.getByTestId("till-taken")).toHaveText("£154.91")
    // What the drawer should hold is in a report, never on the screen itself.
    await expect(page.getByText("£52.48")).toHaveCount(0)

    await page.getByRole("button", { name: "X report", exact: true }).click()
    const report = page.getByTestId("till-report")
    await expect(report).toBeVisible()
    await expect(page.getByTestId("till-report-title")).toHaveText("X report 87")
    await expect(report.getByTestId("report-expected")).toContainText("£52.48")
    await expect(report.getByTestId("report-net")).toContainText("£154.91")
    // The address now names the saved report, not the step that ran it,
    // so going back to it shows this X rather than running another.
    await expect(page).toHaveURL(/report=/)
    await expect(page).not.toHaveURL(/action=x/)

    // Printing says how it went in one line, and nothing else stops.
    await primary(page, "Print").click()
    await expect(page.getByTestId("print-note")).toBeVisible()

    await page.getByRole("button", { name: "Back", exact: true }).click()
    await expect(page.getByTestId("till-state")).toBeVisible()
  })

  test("takes a blind count, closes the till with a Z and opens it again", async ({ page }) => {
    await signIn(page)
    await page.goto("/counter/cash?action=z")

    const close = page.getByTestId("z-close")
    await expect(close).toBeVisible()
    // Blind: nothing says what the drawer should hold until the count is saved.
    await expect(page.getByText("£52.48")).toHaveCount(0)
    await expect(page.getByText(/expected/i)).toHaveCount(0)

    await primary(page, "Close the till").click()
    await expect(page.getByText("Count the drawer before closing the till.")).toBeVisible()

    await countDrawer(page)
    await expect(page.getByTestId("z-total")).toHaveText("£109.60")

    await primary(page, "Close the till").click()
    await expect(page.getByText("Enter the Tide card total for today from the Tide app.")).toBeVisible()
    await expect(page.getByText("From the Tide app, Payments, today's card total.")).toBeVisible()

    await page.getByLabel("Tide card total").fill("130.00")
    await page.getByLabel("To the bank").fill("50.00")
    await page.getByLabel("Notes").fill("Two pound coins short in the bag")
    await primary(page, "Close the till").click()

    const report = page.getByTestId("till-report")
    await expect(page.getByTestId("till-report-title")).toHaveText("Z report 42")
    // £109.60 counted, £50.00 to the bank: £59.60 left against £2.48 expected
    // after the drop, so £57.12 over. In words, not colour.
    await expect(report.getByTestId("report-counted")).toContainText("£59.60")
    await expect(report.getByTestId("report-cash-variance")).toContainText("£57.12 over")
    await expect(report.getByTestId("report-card-variance")).toContainText("£2.43 short")
    await expect(report).toContainText("Two pound coins short in the bag")

    await page.getByRole("button", { name: "Back", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Open the till" })).toBeVisible()

    // Open on the suggested float this time.
    await page.getByRole("button", { name: "Suggested float, £100.00" }).click()
    await expect(page.getByTestId("suggested-float")).toContainText("£100.00")
    await primary(page, "Open the till").click()
    await expect(page.getByTestId("till-state")).toContainText("Opened by Demo Counter on a £100.00 float")
    // A fresh session: nothing taken yet.
    await expect(page.getByTestId("till-taken")).toHaveText("£0.00")
  })

  test("opens the till on a counted float", async ({ page }) => {
    await signIn(page)
    await page.goto("/counter/cash?action=z")
    await countDrawer(page)
    await page.getByLabel("Tide card total").fill("132.43")
    await primary(page, "Close the till").click()
    await expect(page.getByTestId("till-report-title")).toHaveText("Z report 42")
    await page.getByRole("button", { name: "Back", exact: true }).click()

    await primary(page, "Open the till").click()
    await expect(
      page.getByText("Count the float into the drawer, or open on the suggested float.")
    ).toBeVisible()
    await page.locator("#float-2000").fill("2")
    await page.locator("#float-500").fill("4")
    await page.locator("#float-100").fill("10")
    await expect(page.getByTestId("float-total")).toHaveText("£70.00")
    await primary(page, "Open the till").click()
    await expect(page.getByTestId("till-state")).toContainText("£70.00 float")
  })

  test("pays out petty cash, and refuses more than the drawer holds", async ({ page }) => {
    await signIn(page)
    await page.goto("/counter/cash?action=paid_in_out")

    const sheet = page.getByRole("dialog", { name: "Paid in or out" })
    await expect(sheet).toBeVisible()
    await sheet.getByLabel("Amount").fill("5.00")
    await sheet.getByRole("button", { name: "Record paid out" }).click()
    await expect(sheet.getByText("Say what the money was for.")).toBeVisible()

    await sheet.getByLabel("What for").fill("Milk")
    await sheet.getByRole("button", { name: "Record paid out" }).click()
    await expect(sheet).toBeHidden()
    // The server queued no drawer kick, so the counter asked its own
    // printing path, and says in the same line how that went.
    await expect(page.getByTestId("cash-notice")).toContainText("Paid out £5.00: Milk.")

    await page.getByRole("button", { name: "Bank drop", exact: true }).click()
    const drop = page.getByRole("dialog", { name: "Bank drop" })
    await drop.getByLabel("Amount").fill("500.00")
    await drop.getByLabel("Bag or note").fill("Bag 14")
    await drop.getByRole("button", { name: "Record bank drop" }).click()
    await expect(drop.getByText("That is more than the £47.48 the drawer should hold.")).toBeVisible()
  })

  test("opens a past report from the history", async ({ page }) => {
    await signIn(page)
    await page.goto("/counter/cash")

    await page.getByRole("button", { name: "Open Z report 41" }).filter({ visible: true }).click()
    await expect(page.getByTestId("till-report-title")).toHaveText("Z report 41")
    await expect(page.getByTestId("report-cash-variance")).toContainText("£0.40 over")
    await expect(page.getByTestId("report-card-variance")).toContainText("Exact")
  })

  test("asks for a reason before a no sale opens the drawer", async ({ page }) => {
    await signIn(page)
    await page.goto("/counter/cash?action=no_sale")

    const sheet = page.getByRole("dialog", { name: "No sale" })
    await expect(sheet).toBeVisible()
    await sheet.getByRole("button", { name: "Open the drawer" }).click()
    await expect(sheet.getByText("Say why the drawer is being opened.")).toBeVisible()
    await sheet.getByLabel("Why").fill("Customer change")
    await sheet.getByRole("button", { name: "Open the drawer" }).click()
    await expect(page.getByTestId("cash-notice")).toContainText("No sale recorded: Customer change.")

    // Closing the sheet took the step off the address.
    await expect(page).toHaveURL(/\/counter\/cash$/)
  })
})
