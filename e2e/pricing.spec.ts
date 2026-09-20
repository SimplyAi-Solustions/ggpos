import { expect, test, type Page } from "@playwright/test"

/**
 * Live pricing at the counter: the source view, a UK comp, price check and a
 * buy-in line priced from a source rather than from the keyboard.
 *
 * The demo price book (apps/web/src/lib/api/demo/catalogue.ts) gives the
 * Charizard a stale eBay figure, a fresh Cardmarket one in euros, a fresh
 * TCGplayer one in dollars and no UK comp at all, so every state the view can
 * be in is on one card.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

async function signIn(page: Page) {
  await page.goto("/login?demo=1")
  await page.getByLabel("Email").fill(DEMO_EMAIL)
  await page.getByLabel("Password").fill(DEMO_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()
}

/** Below 900px the primary action is a second, docked copy of the button. */
function primary(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true }).filter({ visible: true })
}

function source(page: Page, key: string) {
  return page.locator(`[data-testid="price-source"][data-source="${key}"]`)
}

test.describe("live pricing", () => {
  test("prices a card on Add stock from the sources, and a UK comp takes over", async ({
    page,
  }) => {
    await signIn(page)
    await page.goto("/counter/stock/new")

    await page.getByLabel("Set and number").fill("sv151 199")
    const hit = page.getByRole("option", { name: /Charizard ex/ })
    await expect(hit).toBeVisible()
    await hit.click()

    // Every source in the shop's order, whether it has a figure or not.
    await expect(page.getByTestId("price-sources")).toBeVisible()
    await expect(page.getByTestId("price-source")).toHaveCount(4)
    await expect(source(page, "uk_sold_manual")).toContainText("No value")
    await expect(source(page, "ebay_uk_asking")).toContainText("Stale")
    await expect(source(page, "cardmarket")).toHaveAttribute("data-chosen", "true")
    await expect(source(page, "cardmarket")).toContainText("£316.96")
    // The foreign amount only ever appears beside its conversion.
    await expect(source(page, "cardmarket")).toContainText(
      /from Cardmarket €368\.30 at 0\.8606/
    )
    await expect(source(page, "tcgplayer")).toContainText(/from TCGplayer \$421\.00/)

    // A four-day-old rate is said out loud and blocks nothing.
    await expect(
      page.getByText("FX rate is 4 days old. Converted prices may be off.")
    ).toBeVisible()

    // Market times the top band's markup, rounded to a retail ending.
    await expect(page.getByTestId("suggested-price")).toHaveText("£316.99")
    await expect(page.getByLabel("Price")).toHaveValue("316.99")

    // A UK sold comp leads every automated source for 30 days.
    await page.getByRole("button", { name: "Add UK comp" }).click()
    const sheet = page.getByRole("dialog")
    await expect(sheet).toBeVisible()
    await sheet.getByLabel("Sold for").fill("400.00")
    await sheet
      .getByLabel("Listing")
      .fill("https://www.ebay.co.uk/itm/226119440823")
    await sheet.getByRole("button", { name: "Save comp" }).click()

    await expect(sheet).toBeHidden()
    await expect(source(page, "uk_sold_manual")).toHaveAttribute("data-chosen", "true")
    await expect(source(page, "uk_sold_manual")).toContainText("£400.00")
    await expect(source(page, "uk_sold_manual")).toContainText("UK sold comp, ebay.co.uk")
    await expect(page.getByTestId("suggested-price")).toHaveText("£400.49")
    await expect(page.getByLabel("Price")).toHaveValue("400.49")
  })

  test("says what is wrong with a comp before it goes anywhere near the server", async ({
    page,
  }) => {
    await signIn(page)
    await page.goto("/counter/stock/new")

    await page.getByLabel("Set and number").fill("sv151 199")
    await page.getByRole("option", { name: /Charizard ex/ }).click()
    await page.getByRole("button", { name: "Add UK comp" }).click()

    const sheet = page.getByRole("dialog")
    await sheet.getByLabel("Sold for").fill("400.00")
    await sheet.getByLabel("Listing").fill("https://www.ebay.com/itm/1")
    await sheet.getByRole("button", { name: "Save comp" }).click()

    await expect(
      sheet.getByText(
        "That is not an ebay.co.uk item link. Paste the listing's own URL (ebay.co.uk/itm/...)."
      )
    ).toBeVisible()
    await expect(sheet).toBeVisible()
  })

  test("price-checks a card on Scan without creating anything", async ({ page }) => {
    await signIn(page)
    await page.goto("/counter/scan")

    await page.getByRole("button", { name: "Price check", exact: true }).click()
    const field = page.getByTestId("scan-field")
    await field.fill("sv151 199")
    await field.press("Enter")

    await page.getByTestId("price-check-hit").first().click()
    await expect(page.getByTestId("price-check-name")).toHaveText("Charizard ex")
    // Normal finish: Cardmarket €294.00 at 0.8606.
    await expect(page.getByTestId("price-check-market")).toHaveText("£253.02")

    // The offer band for every condition, from the shared calculator.
    await expect(page.getByTestId("offer-NM")).toContainText("£253.02")
    await expect(page.getByTestId("offer-NM")).toContainText("£152.00")
    await expect(page.getByTestId("offer-NM")).toContainText("£190.00")
    await expect(page.getByTestId("offer-DMG")).toBeVisible()

    // And what we are holding, with its price.
    await expect(page.getByTestId("price-check-stock")).toContainText("GGS-")
    await expect(page.getByTestId("price-check-stock")).toContainText("£324.99")

    // Nothing was created: the scan history is still empty.
    await page.getByRole("button", { name: "Scan", exact: true }).click()
    await expect(page.getByText("Nothing scanned yet at this till.")).toBeVisible()
  })

  test("prices a buy-in line from the source view, with a reason on the line", async ({
    page,
  }) => {
    await signIn(page)
    await page.goto("/counter/trade/new")

    await page.getByLabel("Find them").fill("Jasmine")
    await page.getByRole("button", { name: /Jasmine Okafor/ }).click()
    await primary(page, "Add items").click()

    await page.getByLabel("Set and number").fill("sv151 199")
    await page.getByRole("option", { name: /Charizard ex/ }).click()

    const line = page.getByTestId("trade-line").first()
    const market = line.getByLabel("Market value for Charizard ex")
    // The price route filled it in: no one typed this.
    await expect(market).toHaveValue("253.02")
    await expect(line.getByTestId("market-source")).toContainText(
      /Cardmarket, \d+ hours? ago/
    )
    await expect(page.getByTestId("total-cash")).toHaveText("£152.00")
    await expect(page.getByTestId("total-credit")).toHaveText("£190.00")

    // The whole source view opens on the line itself.
    await line.getByTestId("market-source").click()
    await expect(line.getByTestId("price-sources")).toBeVisible()
    await expect(
      line.locator('[data-testid="price-source"][data-source="cardmarket"]')
    ).toHaveAttribute("data-chosen", "true")

    // Picking another source needs a reason, and the reason stays on the line.
    await line
      .locator('[data-testid="price-source"][data-source="tcgplayer"]')
      .getByRole("button", { name: "Use this" })
      .click()
    const sheet = page.getByRole("dialog")
    await sheet.getByLabel("Reason").fill("TCGplayer matches what these sell for here")
    await sheet.getByRole("button", { name: "Use this source" }).click()

    await expect(market).toHaveValue("255.00")
    await expect(line).toContainText("Overridden: TCGplayer matches what these sell for here")
    // The offer still comes from the bands, over the new market value.
    await expect(page.getByTestId("total-cash")).toHaveText("£153.00")
    await expect(page.getByTestId("total-credit")).toHaveText("£191.50")
  })
})
