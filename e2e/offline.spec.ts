import { expect, test, type Page } from "@playwright/test"

import { buildCode } from "../packages/shared/src/sku"

/**
 * The offline queue, driven through the demo menu's "Simulate offline"
 * switch: a sale taken with nothing listening waits in IndexedDB, the strip
 * under the nav says how many are waiting, reconnecting sends them in order,
 * and anything the server refuses on the way back lands in the conflicts
 * sheet with the server's own sentence.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

/** The demo Charizard, at £324.99, in stock in the Showcase. */
const DEMO_SKU = buildCode("single", "7F3K2")

async function signIn(page: Page) {
  await page.goto("/login?demo=1")
  await page.getByLabel("Email").fill(DEMO_EMAIL)
  await page.getByLabel("Password").fill(DEMO_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()
}

function primary(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true }).filter({ visible: true })
}

async function go(page: Page, action: string) {
  await page.keyboard.press("ControlOrMeta+k")
  const palette = page.getByRole("dialog")
  await expect(palette).toBeVisible()
  await palette.getByText(action, { exact: true }).click()
  await expect(palette).toBeHidden()
}

/** The demo menu's switch, which stands in for pulling the network out. */
async function toggleOffline(page: Page) {
  await page.getByRole("button", { name: /Account menu/ }).click()
  await page.getByRole("menuitem", { name: /Simulate offline/ }).click()
}

async function openDrawer(page: Page) {
  await go(page, "Cash session")
  await page.getByLabel("Float").fill("100.00")
  await primary(page, "Open session").click()
  await expect(page.getByTestId("cash-expected")).toHaveText("£100.00")
}

async function sellForCash(page: Page) {
  const field = page.getByTestId("sell-scan-field")
  await field.fill(DEMO_SKU.display)
  await field.press("Enter")
  await expect(page.getByTestId("basket")).toContainText("Charizard ex")
  await page.getByRole("button", { name: "Cash", exact: true }).click()
  await primary(page, "Mark sold").click()
}

test.describe("the offline queue", () => {
  test("holds a sale taken offline and sends it when the line is back", async ({
    page,
  }) => {
    await signIn(page)
    await openDrawer(page)
    await toggleOffline(page)

    await expect(page.getByTestId("offline-strip")).toContainText("Offline.")

    await go(page, "Sell")
    await sellForCash(page)

    // The sale stands at the counter, and says plainly that it has not gone.
    const done = page.getByTestId("sale-done")
    await expect(done).toContainText("Not sent yet")
    await expect(done).toContainText("£324.99")
    await expect(page.getByTestId("offline-strip")).toContainText(
      "Offline, 1 sale waiting."
    )

    // Undoing something that has not been sent is refused in so many words.
    await page.getByTestId("undo-toast").getByRole("button", { name: "Undo" }).click()
    await expect(
      page.getByText(
        "That sale is still waiting to send, so it cannot be undone yet. Send it first, then refund it."
      )
    ).toBeVisible()

    // Back on the network, the queue empties itself.
    await toggleOffline(page)
    await expect(page.getByTestId("offline-strip")).toHaveCount(0)

    // And the item really did sell.
    await go(page, "Stock")
    await page.getByRole("button", { name: "Sold", exact: true }).click()
    await expect(
      page.getByTestId("stock-row").filter({ hasText: "Charizard ex" }).first()
    ).toBeVisible()
  })

  test("puts a refused replay in front of staff with the server's own words", async ({
    page,
  }) => {
    await signIn(page)
    await openDrawer(page)
    await toggleOffline(page)

    // The same card sold twice while nothing was listening: the second sale
    // cannot stand, and only the server can say so.
    await go(page, "Sell")
    await sellForCash(page)
    await expect(page.getByTestId("sale-done")).toBeVisible()
    await page.getByRole("button", { name: "New sale" }).click()
    await sellForCash(page)
    await expect(page.getByTestId("offline-strip")).toContainText(
      "Offline, 2 sales waiting."
    )

    await toggleOffline(page)

    const strip = page.getByTestId("offline-strip")
    await expect(strip).toContainText("1 action was refused by the server.")
    await strip.getByRole("button", { name: /Review/ }).click()

    const sheet = page.getByTestId("offline-conflicts")
    await expect(sheet).toBeVisible()
    const conflict = page.getByTestId("offline-conflict").first()
    await expect(conflict).toContainText("Charizard ex is no longer for sale.")
    await expect(conflict).toContainText("Charizard ex")
    await expect(conflict).toContainText("£324.99")

    // Staff deal with it and take it off the list. The sheet stays put while
    // they are reading it, and the line goes once it is closed.
    await conflict.getByRole("button", { name: "Take it off the list" }).click()
    await expect(page.getByTestId("offline-conflict")).toHaveCount(0)
    await expect(sheet).toContainText("Nothing is waiting to be sorted out.")
    await sheet.getByRole("button", { name: "Done" }).click()
    await expect(page.getByTestId("offline-strip")).toHaveCount(0)
  })

  test("refuses to queue a label job without saying it printed", async ({ page }) => {
    await signIn(page)

    // Within the tab: a fresh page load would take the simulated connection
    // and the demo stores with it.
    await go(page, "Stock")
    await page
      .getByTestId("stock-row")
      .filter({ hasText: "Charizard ex" })
      .first()
      .click()
    await expect(page.getByTestId("item-sku")).toHaveText(DEMO_SKU.display)

    await toggleOffline(page)
    await primary(page, "Print label").click()

    await expect(
      page.getByText(
        "That label is waiting to send. It queues for the printer once the connection is back."
      )
    ).toBeVisible()
    await expect(page.getByTestId("offline-strip")).toContainText(
      "Offline, 1 label job waiting."
    )
  })
})
