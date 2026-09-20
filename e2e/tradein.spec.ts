import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"

/**
 * The buy-in wizard, end to end against the demo fixtures.
 *
 * `?demo=1` puts the built app into demo mode for the tab, so this runs with
 * no PocketBase behind it: the draft, the lines, the ID check and the
 * completion are all answered in memory, and the completion assigns a real
 * `GG-BI-` number and real SKUs through the shared code helper.
 *
 * Playwright's two projects run this at 1440 and at 390, so the one-handed
 * phone path (docked primary action) and the desktop path are both covered.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

// The suite is compiled to CommonJS by Playwright, so `__dirname` rather
// than `import.meta.url`.
const ID_PHOTO = join(__dirname, "fixtures", "id-sample.png")

/** Below 900px the primary action is a second, docked copy of the button. */
function primary(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true }).filter({ visible: true })
}

async function signIn(page: Page) {
  await page.goto("/login?demo=1")
  await page.getByLabel("Email").fill(DEMO_EMAIL)
  await page.getByLabel("Password").fill(DEMO_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()
}

/** Drags a short stroke across the pad, which is what "signed" means here. */
async function sign(page: Page) {
  const pad = page.getByTestId("signature-pad")
  const box = await pad.boundingBox()
  if (!box) throw new Error("The signature pad has no box to sign on")
  await page.mouse.move(box.x + 30, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 90, box.y + box.height / 2 - 18, { steps: 6 })
  await page.mouse.move(box.x + 150, box.y + box.height / 2 + 14, { steps: 6 })
  await page.mouse.up()
  await expect(page.getByText("Signature captured")).toBeVisible()
}

test.describe("the buy-in wizard", () => {
  test("takes a new customer from nothing to a sealed number", async ({ page }) => {
    await signIn(page)
    await page.goto("/counter/trade")
    await expect(page.getByRole("heading", { name: "Trade" })).toBeVisible()

    await primary(page, "New buy-in").click()
    await expect(page.getByRole("heading", { name: "Buy-in" })).toBeVisible()

    // ---- 1. Customer ----------------------------------------------------
    await page.getByRole("button", { name: "New customer" }).click()
    await page.getByLabel("Name", { exact: true }).fill("Priya Sandhu")
    await page.getByLabel("Phone").fill("07700 900321")
    await page.getByLabel("Email").fill("priya@example.co.uk")
    await page.getByRole("button", { name: "Save and carry on" }).click()

    await expect(page.getByText("Priya Sandhu")).toBeVisible()
    await expect(page.getByText("ID Not on file")).toBeVisible()

    await primary(page, "Add items").click()

    // ---- 2. Items -------------------------------------------------------
    await expect(page.getByText("What they are selling")).toBeVisible()

    await page.getByLabel("Set and number").fill("sv151 199")
    const hit = page.getByRole("option", { name: /Charizard ex/ })
    await expect(hit).toBeVisible()
    await hit.click()

    const cardLine = page.getByTestId("trade-line").first()
    await expect(cardLine).toContainText("Charizard ex")
    await cardLine
      .getByLabel("Market value for Charizard ex")
      .fill("100")

    // A sealed line by kind, with its own quantity.
    await page.getByRole("button", { name: "Sealed", exact: true }).click()
    await page.getByLabel("Title").fill("Surging Sparks Elite Trainer Box")
    await page.getByRole("button", { name: "Add line" }).click()

    const sealedLine = page.getByTestId("trade-line").nth(1)
    await expect(sealedLine).toContainText("Surging Sparks")
    await sealedLine
      .getByLabel("Market value for Surging Sparks Elite Trainer Box")
      .fill("40")

    // £100 NM single is 60 percent cash, the £40 sealed box 55 percent.
    await expect(page.getByTestId("total-cash")).toHaveText("£82.00")
    await expect(page.getByTestId("total-credit")).toHaveText("£103.00")

    await primary(page, "Make the offer").click()

    // ---- 3. Offer -------------------------------------------------------
    await expect(page.getByTestId("tile-cash")).toBeVisible()
    await expect(page.getByTestId("tile-cash")).toContainText("£82.00")
    await expect(page.getByTestId("tile-credit")).toContainText("£103.00")
    await page.getByTestId("tile-cash").click()
    await expect(page.getByTestId("tile-cash")).toHaveAttribute(
      "aria-pressed",
      "true"
    )

    // Nothing moves until the terms are read and the customer signs.
    await primary(page, "Check ID").click()
    await expect(page.getByText("Read the terms to the customer")).toBeVisible()

    await page
      .getByRole("switch", {
        name: "The customer has heard the terms and agrees to them",
      })
      .click()
    await sign(page)

    await primary(page, "Check ID").click()

    // ---- 4. ID gate -----------------------------------------------------
    await expect(page.getByText("Photo of the ID")).toBeVisible()

    // Cash is blocked until the ID is captured, and says what is missing.
    await primary(page, "Complete buy-in").click()
    await expect(
      page.getByText("Photograph the ID before you continue.")
    ).toBeVisible()

    await page.getByTestId("id-photo-input").setInputFiles(ID_PHOTO)
    await expect(page.getByTestId("id-photo-preview")).toBeVisible()

    await page.getByLabel("Expires").fill("2032-06-30")
    await page.getByLabel("Last four digits").fill("4471")
    await page.getByLabel("Date of birth").fill("1994-03-18")
    await page.getByLabel("Address").fill("18 Hill Top, Bolsover, S44 6NB")
    await page
      .getByRole("switch", {
        name: "I have seen the original document and it matches",
      })
      .click()

    await primary(page, "Complete buy-in").click()

    // ---- 5. Done --------------------------------------------------------
    await expect(page.getByRole("heading", { name: "Bought in" })).toBeVisible()
    await expect(page.getByRole("img", { name: "Done" })).toBeVisible()
    const number = await page.getByTestId("buyin-number").innerText()
    expect(number).toMatch(/^GG-BI-\d{6}$/)
    await expect(page.getByText(/labels? queued for the counter printer/)).toBeVisible()

    // ---- the receipt ----------------------------------------------------
    await page.getByRole("button", { name: "Receipt", exact: true }).click()
    await expect(page.getByText(number)).toBeVisible()
    await expect(page.getByText("Charizard ex")).toBeVisible()
    await expect(page.getByText("18 Hill Top, Bolsover, S44 6NB")).toBeVisible()
    await expect(page.getByRole("button", { name: "Print" })).toBeVisible()
  })

  test("refuses cash to a customer marked store credit only", async ({ page }) => {
    await signIn(page)
    await page.goto("/counter/trade/new")

    await page.getByLabel("Find them").fill("Callum")
    await page.getByRole("button", { name: /Callum Reeve/ }).click()
    await expect(page.getByText("No cash", { exact: true })).toBeVisible()
    await expect(
      page.getByText("This customer is marked store credit only.")
    ).toBeVisible()

    await primary(page, "Add items").click()
    await page.getByRole("button", { name: "Retro", exact: true }).click()
    await page.getByLabel("Title").fill("Mario Kart 64, boxed")
    await page.getByRole("button", { name: "Add line" }).click()
    await page
      .getByLabel("Market value for Mario Kart 64, boxed")
      .fill("25")

    await primary(page, "Make the offer").click()
    await expect(page.getByTestId("tile-cash")).toBeDisabled()
    await expect(page.getByTestId("tile-credit")).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    // Credit needs no ID gate, so the next step is the last one.
    await expect(primary(page, "Complete buy-in")).toBeVisible()
  })

  test("goes straight past the ID gate for a customer already verified", async ({
    page,
  }) => {
    await signIn(page)
    await page.goto("/counter/trade/new")

    await page.getByLabel("Find them").fill("Jasmine")
    await page.getByRole("button", { name: /Jasmine Okafor/ }).click()
    await expect(page.getByText("ID Verified")).toBeVisible()

    await primary(page, "Add items").click()
    await page.getByLabel("Set and number").fill("sv151 205")
    await page.getByRole("option", { name: /Mew ex/ }).click()
    await page.getByLabel("Market value for Mew ex").fill("60")

    await primary(page, "Make the offer").click()
    await page.getByTestId("tile-cash").click()
    await page
      .getByRole("switch", {
        name: "The customer has heard the terms and agrees to them",
      })
      .click()
    await sign(page)
    await primary(page, "Check ID").click()

    await expect(page.getByTestId("id-already-verified")).toContainText(
      "is on file"
    )
    await primary(page, "Complete buy-in").click()
    await expect(page.getByRole("heading", { name: "Bought in" })).toBeVisible()
  })
})

test.describe("the customers area", () => {
  test("finds a customer, shows their credit and prints their card", async ({
    page,
  }) => {
    await signIn(page)
    await page.goto("/counter/customers")

    await page.getByLabel("Search customers").fill("Jasmine")
    const row = page.getByRole("link", { name: "Jasmine Okafor" })
    await expect(row).toBeVisible()
    await row.click()

    await expect(page.getByRole("heading", { name: "Jasmine Okafor" })).toBeVisible()
    await expect(page.getByTestId("credit-balance")).toHaveText("£45.00")
    await expect(page.getByTestId("id-status")).toHaveText("Verified")

    await page.getByRole("button", { name: "Print card" }).click()
    await expect(page.getByRole("heading", { name: "Guild card" })).toBeVisible()
    await expect(page.getByTestId("guild-card-front")).toBeVisible()
    await expect(
      page.getByRole("img", { name: "Guild card QR for Jasmine Okafor" })
    ).toBeVisible()
  })

  test("warns about a duplicate while a known number is typed", async ({ page }) => {
    await signIn(page)
    await page.goto("/counter/customers/new")

    await page.getByLabel("Name", { exact: true }).fill("Thomas Bradbury")
    await page.getByLabel("Phone").fill("07700 900456")

    const warning = page.getByTestId("duplicate-warning")
    await expect(warning).toBeVisible()
    await expect(warning).toContainText("Tom Bradbury")
  })
})
