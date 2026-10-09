import { expect, test, type Page } from "@playwright/test"

import { buildCode } from "../packages/shared/src/sku"

/**
 * Selling from the rest of the counter: the item page's "Sell", the stock
 * list afterwards, the labels, and a refund split two ways. The till itself
 * is `till.spec.ts`; the old Sell screen is gone and its address sends
 * everything to the till.
 *
 * The demo stores live in memory for the tab, so this walks the counter the
 * way staff would: every step after sign-in is a click, never a page load.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

/** The demo Charizard, at £324.99, and Mabel at £12.49. */
const DEMO_SKU = buildCode("single", "7F3K2")
const MABEL = buildCode("single", "T4M9P")
const JASMINE = "GGC-4K7M2S"

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
async function go(page: Page, action: string | RegExp) {
  await page.keyboard.press("ControlOrMeta+k")
  const palette = page.getByRole("dialog", { name: "Commands and catalogue search" })
  await expect(palette).toBeVisible()
  await palette
    .getByText(action, typeof action === "string" ? { exact: true } : undefined)
    .first()
    .click()
  await expect(palette).toBeHidden()
}

/** The till, whatever the palette calls it. */
async function goTill(page: Page) {
  await go(page, /^(Sell|Till)$/)
  await expect(page.getByTestId("till")).toBeVisible()
}

async function showItems(page: Page) {
  const tab = page.getByRole("tab", { name: /^(Items|Pay|Done)$/ })
  if (await tab.isVisible()) await tab.click()
}

async function showTicket(page: Page) {
  const tab = page.getByTestId("till-ticket-tab")
  if (await tab.isVisible()) await tab.click()
}

async function scan(page: Page, code: string) {
  await showItems(page)
  const field = page.getByTestId("till-scan-field")
  await field.fill(code)
  await field.press("Enter")
}

async function leaveTill(page: Page) {
  await page.getByRole("link", { name: "Back to the counter" }).click()
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()
}

test.describe("selling at the counter", () => {
  test("sells from the item page, and the stock says it has gone", async ({ page }) => {
    await signIn(page)

    await go(page, "Stock")
    await page.getByTestId("stock-row").filter({ hasText: "Charizard ex" }).first().click()
    await expect(page.getByTestId("item-sku")).toHaveText(DEMO_SKU.display)
    await primary(page, "Sell").click()

    // The old Sell address lands on the till with the card on the ticket.
    await expect(page).toHaveURL(/\/counter\/till/)
    await showTicket(page)
    await expect(page.getByTestId("ticket-line")).toContainText("Charizard ex")

    await page.getByTestId("till-pay").filter({ visible: true }).click()
    await showItems(page)
    await page.getByRole("button", { name: "Cash", exact: true }).click()
    await page.getByRole("button", { name: "Exact" }).click()
    await expect(page.getByTestId("till-done")).toContainText(/GG-S-\d{6}/)
    await page.getByTestId("till-new-sale").click()

    await leaveTill(page)
    await go(page, "Stock")
    await page.getByRole("button", { name: "Sold", exact: true }).click()
    await page.getByTestId("stock-row").filter({ hasText: "Charizard ex" }).first().click()
    await expect(page.getByTestId("item-status")).toHaveText("Sold")
    await expect(page.getByTestId("item-price")).toHaveText("£324.99")
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

  test("refunds a sale paid two ways to the two places staff choose", async ({ page }) => {
    await signIn(page)
    await goTill(page)

    // Jasmine pays £12.49 with £2.49 of store credit and £10.00 in cash.
    await scan(page, JASMINE)
    await scan(page, MABEL.display)
    await page.getByTestId("till-pay").filter({ visible: true }).click()
    await showItems(page)
    await page.getByRole("button", { name: "Store credit", exact: true }).click()
    // The pad starts at the most that can go on; Delete clears it.
    await page.keyboard.press("Delete")
    await page.keyboard.type("249")
    await page.getByTestId("till-take-credit").click()
    await expect(page.getByTestId("till-to-pay")).toHaveText("£10.00")
    await page.getByRole("button", { name: "Cash", exact: true }).click()
    await page.getByRole("button", { name: "Exact" }).click()
    const number = (await page.getByTestId("till-sale-number").innerText()).trim()
    await page.getByTestId("till-new-sale").click()

    // Back it comes, half to store credit and half as cash.
    await page.getByRole("button", { name: "Till menu" }).click()
    await page.getByRole("menuitem", { name: "Returns" }).click()
    const sheet = page.getByTestId("returns-sheet")
    await sheet.getByLabel("Sale number").fill(number)
    await sheet.getByTestId("returns-find").click()
    await expect(sheet.getByTestId("returns-sale-number")).toHaveText(number)
    await sheet.getByLabel("Reason").fill("Changed their mind")

    await sheet.getByRole("button", { name: "Store credit", exact: true }).click()
    await expect(sheet.getByRole("button", { name: "Cash", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    await sheet.getByLabel("Store credit").fill("5.00")
    await sheet.getByLabel("Cash", { exact: true }).fill("5.00")
    await sheet.getByTestId("returns-refund").click()
    await expect(
      sheet.getByText("Those come to £10.00 but the refund is £12.49. Make them match.")
    ).toBeVisible()

    await sheet.getByLabel("Cash", { exact: true }).fill("7.49")
    await sheet.getByTestId("returns-refund").click()
    await expect(sheet.getByTestId("returns-done")).toContainText("£12.49")
    await expect(sheet.getByTestId("returns-done")).toContainText(`${number}-R1`)
  })
})
