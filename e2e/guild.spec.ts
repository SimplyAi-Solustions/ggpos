import { expect, test, type Page } from "@playwright/test"

import { buildCode } from "../packages/shared/src/sku"

/**
 * The GG Guild and its offers (docs/api-contract-launch.md, section 2):
 * joining at the till and seeing the points, a new customer joining from
 * the till's search, an offer made in Loyalty with its example and the
 * till's points preview following it, and joining from the customer page.
 *
 * Driven against the demo stores, which refuse what the routes refuse in the
 * same sentences. They live in memory for the tab, so every step after
 * sign-in is a click. Playwright's two projects run the file at 1440 and at
 * 390.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

/** The demo Charizard ex, a Pokémon single at £324.99, and Mabel at £12.49. */
const CHARIZARD = buildCode("single", "7F3K2")
const MABEL = buildCode("single", "T4M9P")
/** T Bradbury signed in to My Vault but has not joined; Tom is a Member. */
const T_BRADBURY = buildCode("customer", "H2V8R")
const TOM = buildCode("customer", "9QB3X")

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
  const palette = page.getByRole("dialog", { name: "Commands and catalogue search" })
  await expect(palette).toBeVisible()
  await palette.getByText(action, { exact: true }).first().click()
  await expect(palette).toBeHidden()
}

async function goTill(page: Page) {
  await page.keyboard.press("ControlOrMeta+k")
  const palette = page.getByRole("dialog", { name: "Commands and catalogue search" })
  await expect(palette).toBeVisible()
  await palette.getByText(/^(Sell|Till)$/).first().click()
  await expect(palette).toBeHidden()
  await expect(page.getByTestId("till")).toBeVisible()
}

async function tillScan(page: Page, code: string) {
  const items = page.getByRole("tab", { name: /^(Items|Pay|Done)$/ })
  if (await items.isVisible()) await items.click()
  const field = page.getByTestId("till-scan-field")
  await field.fill(code)
  await field.press("Enter")
}

async function showTicket(page: Page) {
  await expect(page.getByTestId("till")).toBeVisible()
  const tab = page.getByTestId("till-ticket-tab")
  if (await tab.isVisible()) await tab.click()
}

async function joinInSheet(page: Page) {
  const sheet = page.getByRole("dialog", { name: "Join the Guild" })
  await expect(sheet).toBeVisible()
  const submit = sheet.getByTestId("join-guild-submit")
  // Nobody joins without agreeing to the terms.
  await expect(submit).toBeDisabled()
  await sheet.getByRole("switch", { name: "They agree to the Guild terms" }).click()
  await submit.click()
  await expect(sheet).toBeHidden()
}

test.describe("the GG Guild", () => {
  test("joins a customer at the till, and the sale earns the points", async ({ page }) => {
    await signIn(page)
    await goTill(page)
    await tillScan(page, MABEL.display)
    await tillScan(page, T_BRADBURY.display)
    await expect(page.getByText("T Bradbury attached")).toBeVisible()

    await showTicket(page)
    const customer = page.getByTestId("ticket-customer")
    await expect(customer.getByTestId("ticket-not-member")).toHaveText("Not in the Guild")
    // Points belong to members, so the ticket earns none and says nothing.
    await expect(page.getByTestId("ticket-points")).toHaveCount(0)

    await customer.getByRole("button", { name: "Join the Guild" }).click()
    await joinInSheet(page)

    await expect(
      page.getByText("T Bradbury joined the Guild with 100 points.").filter({ visible: true }).first()
    ).toBeVisible()
    await showTicket(page)
    await expect(page.getByTestId("ticket-not-member")).toHaveCount(0)
    await expect(page.getByTestId("ticket-customer")).toContainText("100 points")
    // £12.49 at ten points a pound.
    await expect(page.getByTestId("ticket-points")).toHaveText("125 points")
  })

  test("makes a new customer from the till's search and joins them in one step", async ({ page }) => {
    await signIn(page)
    await goTill(page)
    await tillScan(page, MABEL.display)
    await showTicket(page)
    await page.getByRole("button", { name: "Add customer" }).click()

    const search = page.getByRole("dialog", { name: "Attach customer" })
    await search.getByLabel("Search customers").fill("Priya Patel")
    await expect(search.getByText(/No customer matches that/)).toBeVisible()
    await search.getByRole("button", { name: "New customer, join the Guild" }).click()

    const sheet = page.getByRole("dialog", { name: "Join the Guild" })
    await expect(sheet.getByLabel("Name")).toHaveValue("Priya Patel")

    // An email already on a card is refused, naming whose it is.
    await sheet.getByLabel("Email").fill("jasmine.okafor@example.co.uk")
    await sheet.getByRole("switch", { name: "They agree to the Guild terms" }).click()
    await sheet.getByTestId("join-guild-submit").click()
    await expect(
      sheet.getByText("Jasmine Okafor already has that email. Open their record instead.")
    ).toBeVisible()
    await expect(sheet.getByRole("button", { name: "Attach Jasmine Okafor instead" })).toBeVisible()

    await sheet.getByLabel("Email").fill("priya.patel@example.co.uk")
    await sheet.getByTestId("join-guild-submit").click()
    await expect(sheet).toBeHidden()

    await expect(
      page.getByText("Priya Patel joined the Guild with 100 points.").filter({ visible: true }).first()
    ).toBeVisible()
    await showTicket(page)
    await expect(page.getByTestId("ticket-customer")).toContainText("Priya Patel")
    await expect(page.getByTestId("ticket-customer")).toContainText("100 points")
    await expect(page.getByTestId("ticket-points")).toHaveText("125 points")
  })

  test("makes an offer on a branch, shows its example, and the till's points follow", async ({ page }) => {
    await signIn(page)

    // The till first: Tom, a Member, buying the Pokémon Charizard.
    await goTill(page)
    await tillScan(page, CHARIZARD.display)
    await tillScan(page, TOM.display)
    await expect(page.getByText("Tom Bradbury attached")).toBeVisible()

    await go(page, "Loyalty")
    await expect(page.getByRole("heading", { name: "Loyalty" })).toBeVisible()
    const offers = page.getByTestId("loyalty-offers")
    await expect(offers.getByTestId("offer-rate")).toContainText("Earn 10 points for every £1")
    // The seeded Saturday offer is switched off, so the figures do not
    // depend on the day the suite runs.
    const saturday = page.getByRole("switch", { name: "2 times points on Saturdays: on" })
    await saturday.click()
    await expect(saturday).not.toBeChecked()

    await goTill(page)
    await showTicket(page)
    await expect(page.getByTestId("ticket-points")).toHaveText("3,250 points")

    // ---- The offer, from its template ---------------------------------
    await go(page, "Loyalty")
    await page.getByRole("button", { name: "New offer" }).click()
    const templates = page.getByRole("dialog", { name: "New offer" })
    await templates.getByRole("button", { name: "N times points on branches, items or products" }).click()

    const sheet = page.getByRole("dialog", { name: "Offer" })
    await expect(sheet).toBeVisible()
    await sheet.getByLabel("Times points").fill("3")
    await sheet.getByLabel("Branches").fill("Pokémon")
    await sheet.getByRole("button", { name: "Trading cards / Pokémon", exact: true }).click()
    await expect(sheet.getByTestId("offer-sheet-example")).toHaveText(
      "A £30.00 Pokémon sale earns 900 points."
    )
    await sheet.getByRole("button", { name: "Save offer" }).click()
    await expect(sheet).toBeHidden()

    const row = offers.getByTestId("offer-row").filter({ hasText: "3 times points on Trading cards / Pokémon" })
    await expect(row).toBeVisible()
    await expect(row.getByTestId("offer-row-example")).toHaveText("A £30.00 Pokémon sale earns 900 points.")

    // ---- And the till prices it -----------------------------------------
    await goTill(page)
    await showTicket(page)
    await expect(page.getByTestId("ticket-points")).toHaveText("9,750 points")
  })

  test("joins a customer from their page", async ({ page }) => {
    await signIn(page)
    await go(page, "Customers")
    await page.getByLabel("Search customers").fill("T Bradbury")
    await page.getByRole("link", { name: "T Bradbury", exact: true }).click()
    await expect(page.getByRole("heading", { name: "T Bradbury" })).toBeVisible()

    const guild = page.getByTestId("guild-section")
    await expect(guild.getByTestId("guild-status")).toHaveText(
      "Not in the Guild yet. Their purchases earn points once they join."
    )
    await guild.getByRole("button", { name: "Join the Guild" }).click()
    await joinInSheet(page)

    await expect(guild.getByTestId("guild-status")).toContainText("In the Guild since")
    await expect(guild.getByRole("button", { name: "Join the Guild" })).toHaveCount(0)
    await expect(page.getByText("T Bradbury joined the Guild with 100 points.")).toBeVisible()
  })

  test("sets the paid upgrade's price in Settings, and the till sells at it", async ({ page }) => {
    await signIn(page)
    await go(page, "Settings")
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible()

    const guild = page.getByTestId("guild-settings")
    await expect(guild.getByLabel("Welcome bonus")).toHaveValue("100")
    await guild.getByLabel("Membership price").fill("30.00")
    await guild.getByRole("button", { name: "Save the Guild" }).click()
    await expect(guild.getByTestId("guild-settings-saved")).toBeVisible()

    await goTill(page)
    const items = page.getByRole("tab", { name: /^(Items|Pay|Done)$/ })
    if (await items.isVisible()) await items.click()
    await expect(page.getByTestId("till-tile").filter({ hasText: "Guild Membership" }).first()).toContainText(
      "£30.00"
    )
  })
})

test.describe("joining from My Vault", () => {
  // The built app's service worker is not under test here (see portal.spec.ts).
  test.use({ serviceWorkers: "block" })

  test("asks for the terms, then joins", async ({ page }) => {
    await page.goto("/account?demo=1")
    await expect(page.getByRole("heading", { name: "My Vault" })).toBeVisible()
    await page.getByLabel("Email").fill("tom.bradbury@example.co.uk")
    await page.getByRole("button", { name: "Send me a code" }).click()
    await page.getByLabel("Code", { exact: true }).fill("48213976")
    await page.getByRole("button", { name: "Sign in" }).click()
    await expect(page.getByRole("heading", { name: "My card" })).toBeVisible()
    await expect(page.getByTestId("portal-not-member")).toContainText("You are not in the GG Guild yet")

    await page.goto("/account/guild")
    const join = page.getByTestId("join-guild")
    await expect(join).toContainText("You start with 100 points.")
    await expect(page.getByTestId("guild-terms")).toContainText("Points are earned on what you pay")

    const button = page.getByTestId("portal-join-guild").filter({ visible: true })
    await expect(button).toBeDisabled()
    await join.getByRole("switch", { name: "I agree to the Guild terms" }).click()
    await button.click()

    await expect(page.getByTestId("join-guild")).toHaveCount(0)
    await expect(page.getByRole("link", { name: "See rewards" }).filter({ visible: true })).toBeVisible()
  })
})
