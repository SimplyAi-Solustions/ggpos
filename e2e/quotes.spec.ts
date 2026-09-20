import { expect, test, type Page } from "@playwright/test"

/**
 * The quote queue, end to end against the demo fixtures.
 *
 * `?demo=1` puts the built app into demo mode for the tab, so this runs with
 * no PocketBase behind it: the queue, the offer, the thread, the received
 * route and the draft buy-in it creates are all answered in memory, and the
 * offer is priced by the very evaluator the counter prices a buy-in with.
 *
 * Playwright's two projects run this at 1440 and at 390, so the docked
 * primary action and the desktop row are both covered.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

/** The three demo quotes the counter's queue opens on. */
const NEW_QUOTE = "quote_demo_3" // submitted, Tom Bradbury, four photos
const OFFERED_QUOTE = "quote_demo_1" // offered, waiting on the customer
const ACCEPTED_QUOTE = "quote_demo_4" // accepted, ready to receive

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

/** Puts one priced line on the quote, the way a staff member would. */
async function addChargeLine(page: Page) {
  await page.getByLabel("Set and number").fill("sv151 199")
  await page.getByRole("option").first().waitFor()
  await page.getByRole("option").first().click()
  await page.getByLabel("Market value for Charizard ex").fill("100")
}

test.describe("the quote queue", () => {
  test("lists what has come in, and filters it by status", async ({ page }) => {
    await signIn(page)
    await page.goto("/counter/quotes?demo=1")

    await expect(page.getByRole("heading", { name: "Quotes" })).toBeVisible()
    const rows = page.getByTestId("quote-row")
    await expect(rows).toHaveCount(4)
    // Newest first: the one nobody has picked up yet is at the top.
    await expect(rows.first()).toContainText("Tom Bradbury")
    await expect(rows.first()).toContainText("4 photos")

    await page.getByRole("button", { name: "Waiting", exact: true }).click()
    await expect(page.getByTestId("quote-row")).toHaveCount(1)
    await expect(page.getByTestId("quote-row").first()).toContainText("Tom Bradbury")

    // Several chips are an or, not an and.
    await page.getByRole("button", { name: "Accepted", exact: true }).click()
    await expect(page.getByTestId("quote-row")).toHaveCount(2)
  })

  test("carries the count into the Trade nav and Home's waiting line", async ({
    page,
  }) => {
    await signIn(page)
    // One quote is waiting to be priced, and one hold runs out today.
    await expect(page.getByTestId("nav-quote-count").first()).toHaveText("1")
    const waiting = page.getByTestId("waiting-line")
    await expect(waiting).toContainText("1 quote to price")
    await expect(waiting).toContainText("1 hold ends today")

    await waiting.getByRole("link", { name: "Quotes" }).click()
    await expect(page.getByRole("heading", { name: "Quotes" })).toBeVisible()
  })

  test("is in the command palette", async ({ page }) => {
    await signIn(page)
    await page.keyboard.press("ControlOrMeta+k")
    const palette = page.getByRole("dialog")
    await expect(palette).toBeVisible()
    await palette.getByText("Quotes", { exact: true }).click()
    await expect(page.getByRole("heading", { name: "Quotes" })).toBeVisible()
  })
})

test.describe("one quote", () => {
  test("goes from photos to an offer", async ({ page }) => {
    await signIn(page)
    await page.goto(`/counter/quotes/${NEW_QUOTE}?demo=1`)

    await expect(page.getByRole("heading", { name: "Quote" })).toBeVisible()
    await expect(page.getByTestId("quote-status")).toHaveText("New")
    await expect(page.getByRole("link", { name: "Tom Bradbury" })).toBeVisible()

    // The photos, one at a time, with the counter under them.
    const photos = page.getByTestId("quote-photos")
    await expect(photos).toContainText("Photo 1 of 4")
    await photos.getByRole("button", { name: "Show photo 3" }).click()
    await expect(photos).toContainText("Photo 3 of 4")

    // Picking it up is a tracked link, and the status comes back from the
    // record rather than being assumed here.
    await page.getByRole("button", { name: "Mark as reviewing" }).click()
    await expect(page.getByTestId("quote-status")).toHaveText("Reviewing")

    // The buy-in's own line row: a card, a market value, the shop's bands.
    await addChargeLine(page)
    await expect(page.getByTestId("total-cash")).toHaveText("£60.00")
    await expect(page.getByTestId("quote-offer-draft")).toHaveText("£60.00")

    await page.getByLabel("With the offer").fill("Happy to look at the carts too.")
    await primary(page, "Send the offer").click()

    await expect(page.getByTestId("quote-status")).toHaveText("Offered")
    await expect(page.getByTestId("quote-offer-total")).toHaveText("£60.00")
    await expect(page.getByTestId("quote-thread")).toContainText(
      "Happy to look at the carts too."
    )
  })

  test("says what to do when nothing has been priced yet", async ({ page }) => {
    await signIn(page)
    await page.goto(`/counter/quotes/${NEW_QUOTE}?demo=1`)
    await primary(page, "Send the offer").click()

    await expect(
      page.getByText("Add a line for each thing in the photos before you send the offer.")
    ).toBeVisible()
    await expect(page.getByTestId("quote-status")).toHaveText("New")
  })

  test("shows an offer that has gone out, and takes a message", async ({ page }) => {
    await signIn(page)
    await page.goto(`/counter/quotes/${OFFERED_QUOTE}?demo=1`)

    await expect(page.getByTestId("quote-status")).toHaveText("Offered")
    await expect(page.getByTestId("quote-offer-total")).toHaveText("£42.00")
    // Waiting on the customer, so there is nothing for the counter to press.
    await expect(page.getByRole("button", { name: "Send the offer" })).toHaveCount(0)

    await page.getByLabel("Reply").fill("No rush, it holds for a week.")
    await page.getByRole("button", { name: "Send message" }).click()
    await expect(page.getByTestId("quote-thread")).toContainText(
      "No rush, it holds for a week."
    )
  })

  test("turns an accepted quote into a draft buy-in", async ({ page }) => {
    await signIn(page)
    await page.goto(`/counter/quotes/${ACCEPTED_QUOTE}?demo=1`)

    await expect(page.getByTestId("quote-status")).toHaveText("Accepted")
    await expect(page.getByTestId("quote-offer-total")).toHaveText("£90.00")

    await primary(page, "Mark as received").click()

    // The wizard opens on the draft, at the items step, with the quote's
    // own lines already on it.
    await expect(page.getByRole("heading", { name: "Buy-in" })).toBeVisible()
    await expect(page).toHaveURL(/\/counter\/trade\/trade_/)
    await expect(page.getByTestId("trade-line")).toHaveCount(2)
    await expect(page.getByTestId("trade-line").first()).toContainText("Blastoise")
  })

  test("cancels with a reason, and says so to the customer", async ({ page }) => {
    await signIn(page)
    await page.goto(`/counter/quotes/${OFFERED_QUOTE}?demo=1`)

    await page.getByRole("button", { name: "Cancel this quote" }).click()
    const sheet = page.getByRole("dialog")
    await expect(sheet).toBeVisible()
    await sheet.getByLabel("Why").fill("Not something we buy at the moment.")
    await sheet.getByRole("button", { name: "Cancel the quote" }).click()
    await expect(sheet).toBeHidden()

    await expect(page.getByTestId("quote-status")).toHaveText("Declined")
    await expect(page.getByTestId("quote-thread")).toContainText(
      "Not something we buy at the moment."
    )
    // A closed quote cannot be cancelled twice.
    await expect(page.getByRole("button", { name: "Cancel this quote" })).toHaveCount(0)
  })
})

test.describe("holds", () => {
  test("says who an item is held for, on the item page", async ({ page }) => {
    await signIn(page)
    await page.goto("/counter/stock?status=reserved&demo=1")
    await page.getByRole("link", { name: /Pidgeot ex/ }).first().click()

    await expect(page.getByTestId("item-status")).toHaveText("Reserved")
    const hold = page.getByTestId("item-hold")
    await expect(hold).toContainText("Held for Tom Bradbury until")
    await expect(hold.getByRole("link", { name: "Tom Bradbury" })).toBeVisible()
  })
})

test.describe("notification settings", () => {
  test("shows how email and push go out, and takes the hold window", async ({
    page,
  }) => {
    await signIn(page)
    await page.goto("/counter/settings?demo=1")
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible()

    await expect(
      page.getByRole("heading", { level: 2, name: "Notifications" })
    ).toHaveCount(1)
    // A fresh shop is in test mode with no provider and no push key.
    await expect(page.getByText("Test mode", { exact: true })).toBeVisible()
    await expect(page.getByTestId("vapid-key")).toHaveText("Set at deploy")
    await expect(page.getByLabel("Hold", { exact: true })).toHaveValue("48")
    await expect(page.getByLabel("Quote expiry")).toHaveValue("7")

    await page.getByLabel("Hold", { exact: true }).fill("72")
    await expect(page.getByTestId("dirty-hint")).toBeVisible()
    await primary(page, "Save settings").click()
    await expect(page.getByTestId("settings-saved")).toBeVisible()
    await expect(page.getByLabel("Hold", { exact: true })).toHaveValue("72")

    await page.getByLabel("Hold", { exact: true }).fill("nought")
    await primary(page, "Save settings").click()
    await expect(
      page.getByText("Enter the number of hours a hold lasts, for example 48.")
    ).toBeVisible()
  })
})
