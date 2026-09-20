import { expect, test, type Page } from "@playwright/test"

/**
 * The SumUp comparison on the Cash screen, at both widths.
 *
 * The demo day deliberately does not line up: one transaction matches a
 * sale, one transaction has no sale behind it, and one card sale never
 * reached SumUp. Matching one by hand is a link and nothing more, so the
 * drawer's own figures are checked before and after.
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

async function go(page: Page, action: string) {
  await page.keyboard.press("ControlOrMeta+k")
  const palette = page.getByRole("dialog")
  await expect(palette).toBeVisible()
  await palette.getByText(action, { exact: true }).click()
  await expect(palette).toBeHidden()
}

/** The section only shows under an open drawer, so open one first. */
async function openDrawer(page: Page) {
  await go(page, "Cash session")
  await expect(page.getByRole("heading", { level: 1, name: "Cash" })).toBeVisible()
  const float = page.getByLabel("Float")
  if (await float.isVisible()) {
    await float.fill("100.00")
    await page
      .getByRole("button", { name: "Open session", exact: true })
      .filter({ visible: true })
      .click()
  }
  await expect(page.getByTestId("cash-expected")).toBeVisible()
}

test.describe("sumup on the cash screen", () => {
  test("compares card takings on both sides", async ({ page }) => {
    await signIn(page)
    await openDrawer(page)

    const section = page.getByTestId("sumup-section")
    await expect(section).toBeVisible()

    // Three transactions of £47.45, £12.00 and £8.99 against three card
    // sales whose card shares are £47.45, £12.00 and £22.50.
    await expect(page.getByTestId("sumup-totals")).toContainText("£68.44")
    await expect(page.getByTestId("sumup-totals")).toContainText("£81.95")
    await expect(page.getByTestId("sumup-difference")).toHaveText("-£13.51")
    await expect(section).toContainText("The Vault has more card sales than SumUp took.")

    await expect(page.getByTestId("sumup-matched").locator("li")).toHaveCount(1)
    await expect(
      page.getByTestId("sumup-unmatched-transactions").locator("li")
    ).toHaveCount(2)
    await expect(page.getByTestId("sumup-unmatched-sales").locator("li")).toHaveCount(2)

    // A mixed sale is compared on its card share, not its total.
    await expect(page.getByTestId("sumup-unmatched-sales")).toContainText(
      "Mixed, £12.00 on card"
    )
  })

  test("matches a transaction to a sale without touching the drawer", async ({
    page,
  }) => {
    await signIn(page)
    await openDrawer(page)

    const expectedBefore = await page.getByTestId("cash-expected").textContent()

    await page
      .getByTestId("sumup-unmatched-transactions")
      .getByRole("button", { name: "Match" })
      .first()
      .click()

    const sheet = page.getByRole("dialog")
    await expect(sheet).toBeVisible()
    // Same amount first: the £12.00 transaction offers the mixed sale whose
    // card share is £12.00 ahead of anything else.
    const candidates = sheet.getByTestId("match-candidates").locator("li")
    await expect(candidates.first()).toContainText("Same amount")
    await candidates.first().getByRole("button").click()
    await sheet.getByRole("button", { name: "Confirm the match" }).click()
    await expect(sheet).toBeHidden()

    await expect(page.getByTestId("sumup-matched").locator("li")).toHaveCount(2)
    // Nothing about the drawer moved: this is a comparison, not a ledger.
    await expect(page.getByTestId("cash-expected")).toHaveText(expectedBefore ?? "")
  })

  test("fetches from SumUp and says what came back", async ({ page }) => {
    await signIn(page)
    await openDrawer(page)

    const section = page.getByTestId("sumup-section")
    await expect(section).toContainText("Card takings for")
    await section.getByRole("button", { name: "Fetch from SumUp" }).click()
    await expect(section).toContainText("3 fetched")
    await expect(section).toContainText("refunded")
  })
})
