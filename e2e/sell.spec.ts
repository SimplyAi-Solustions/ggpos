import { expect, test, type Page } from "@playwright/test"

import { buildCode } from "../packages/shared/src/sku"

/**
 * Selling, the drawer and the labels, driven against the demo fixtures.
 *
 * The demo stores live in memory for the tab, exactly as the item store Add
 * stock writes to does, so this walks the counter the way staff would: every
 * step after sign-in is a click, never a fresh page load.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

/** The demo Charizard, at £324.99. */
const DEMO_SKU = buildCode("single", "7F3K2")

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

async function scan(page: Page, code: string) {
  const field = page.getByTestId("sell-scan-field")
  await field.fill(code)
  await field.press("Enter")
}

test.describe("selling at the counter", () => {
  test("opens the drawer, sells, undoes, sells again and closes the drawer", async ({
    page,
  }) => {
    await signIn(page)

    // ---- Open a cash session -------------------------------------------
    await go(page, "Cash session")
    await expect(page.getByRole("heading", { name: "Cash" })).toBeVisible()
    await page.getByLabel("Float").fill("100.00")
    await primary(page, "Open session").click()
    await expect(page.getByTestId("cash-expected")).toHaveText("£100.00")

    // ---- Sell the demo card for cash ------------------------------------
    await go(page, "Sell")
    await expect(page.getByRole("heading", { name: "Sell" })).toBeVisible()
    await expect(page.getByText("Nothing in the basket. Scan an item to start.")).toBeVisible()

    await scan(page, DEMO_SKU.display)
    await expect(page.getByTestId("basket")).toContainText("Charizard ex")
    await expect(page.getByTestId("sell-total")).toHaveText("£324.99")

    await page.getByRole("button", { name: "Cash", exact: true }).click()
    await primary(page, "Mark sold").click()

    const done = page.getByTestId("sale-done")
    await expect(done).toBeVisible()
    await expect(done).toContainText(/GG-S-\d{6}/)
    await expect(done).toContainText("£324.99")

    // ---- Undo it, which is a refund behind a password -------------------
    const toast = page.getByTestId("undo-toast")
    await expect(toast).toBeVisible()
    await toast.getByRole("button", { name: "Undo" }).click()

    const stepUp = page.getByRole("dialog", {
      name: "Confirm your password to continue",
    })
    await expect(stepUp).toBeVisible()
    await stepUp.getByLabel("Password").fill(DEMO_PASSWORD)
    await stepUp.getByRole("button", { name: "Continue" }).click()

    await expect(toast).toBeHidden()
    await expect(page.getByTestId("sale-done")).toBeHidden()

    // ---- Sell it again, this time on the card ---------------------------
    await scan(page, DEMO_SKU.display)
    await expect(page.getByTestId("basket")).toContainText("Charizard ex")
    await page.getByRole("button", { name: "SumUp card", exact: true }).click()
    await expect(page.getByTestId("sumup-amount")).toHaveText("£324.99")

    await primary(page, "Mark sold").click()
    await expect(page.getByTestId("sale-done")).toContainText(/GG-S-\d{6}/)

    // ---- The item page says it has gone ---------------------------------
    await go(page, "Stock")
    await expect(page.getByRole("heading", { name: "Stock" })).toBeVisible()
    await page.getByRole("button", { name: "Sold", exact: true }).click()
    await page
      .getByTestId("stock-row")
      .filter({ hasText: "Charizard ex" })
      .first()
      .click()

    await expect(page.getByTestId("item-sku")).toHaveText(DEMO_SKU.display)
    await expect(page.getByTestId("item-status")).toHaveText("Sold")
    await expect(page.getByTestId("item-price")).toHaveText("£324.99")

    // ---- Close the drawer against a count -------------------------------
    await go(page, "Cash session")
    // The cash sale was undone, so the drawer is back to its float.
    await expect(page.getByTestId("cash-expected")).toHaveText("£100.00")
    await page.getByLabel("Counted").fill("95.00")
    await expect(page.getByTestId("cash-variance")).toContainText("Short £5.00")
    await expect(page.getByTestId("cash-variance")).toContainText("In tolerance")

    await primary(page, "Close session").click()
    await expect(page.getByTestId("cash-closed")).toBeVisible()
    await expect(page.getByTestId("closed-variance")).toContainText("Short £5.00")
  })

  test("prints one page per queued label", async ({ page }) => {
    await signIn(page)

    // The two labels the demo counter starts the morning with.
    await page.goto("/labels/print?jobs=label_demo_1,label_demo_2&print=0")
    await expect(page.getByTestId("label-sheet")).toBeVisible()
    await expect(page.getByTestId("label-page")).toHaveCount(2)
    await expect(page.getByTestId("label-page").first()).toContainText("Charizard ex")
    await expect(page.getByTestId("label-page").first()).toContainText("£324.99")

    await page.goto("/labels/print?jobs=label_demo_1&print=0")
    await expect(page.getByTestId("label-page")).toHaveCount(1)
  })

  test("asks where a split payment goes back instead of undoing it blind", async ({
    page,
  }) => {
    await signIn(page)

    await go(page, "Cash session")
    await page.getByLabel("Float").fill("100.00")
    await primary(page, "Open session").click()
    await expect(page.getByTestId("cash-expected")).toHaveText("£100.00")

    await go(page, "Sell")
    await scan(page, DEMO_SKU.display)
    await page.getByRole("button", { name: "Mixed", exact: true }).click()

    // A three-decimal amount is refused rather than quietly becoming nothing.
    await page.getByLabel("Cash").fill("100.005")
    await expect(page.getByText("Pounds and pence, for example 12.50.")).toBeVisible()

    await page.getByLabel("Cash").fill("100.00")
    await page.getByLabel("SumUp card").fill("224.99")
    await expect(page.getByTestId("sumup-amount")).toHaveText("£224.99")

    await primary(page, "Mark sold").click()
    const done = page.getByTestId("sale-done")
    await expect(done).toBeVisible()

    const toast = page.getByTestId("undo-toast")
    await expect(toast).toContainText("Split payment")
    await toast.getByRole("button", { name: "Undo" }).click()

    // The refund sheet, with the method chips, rather than a silent card refund.
    const sheet = page.getByRole("dialog").filter({ hasText: "Refund" })
    await expect(sheet).toBeVisible()
    await expect(sheet.getByRole("button", { name: "Store credit" })).toBeVisible()
    await expect(sheet.getByRole("button", { name: "Cash", exact: true })).toBeVisible()
  })

  test("says what is wrong when cash is taken with no session open", async ({
    page,
  }) => {
    await signIn(page)
    await go(page, "Sell")

    await scan(page, DEMO_SKU.display)
    await page.getByRole("button", { name: "Cash", exact: true }).click()

    await expect(
      page.getByText("Open a cash session before taking cash.")
    ).toBeVisible()
    await expect(primary(page, "Mark sold")).toBeDisabled()
  })
})
