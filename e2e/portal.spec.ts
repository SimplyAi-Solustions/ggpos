import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"

/**
 * My Vault, end to end against the demo fixtures.
 *
 * `?demo=1` puts the built app into demo mode for the tab, so this runs with
 * no PocketBase behind it: the code, the card, the quotes, the want list and
 * the erasure refusal are all answered in memory.
 *
 * Playwright's two projects run this at 1440 and at 390, so the thumb bar and
 * the docked primary action are covered along with the desktop path.
 */

const DEMO_EMAIL = "jasmine.okafor@example.co.uk"
const DEMO_CODE = "48213976"
const DEMO_QR_TOKEN = "demo-4k7m2-token"

// Playwright compiles the suite to CommonJS, so `__dirname`.
const PHOTO = join(__dirname, "fixtures", "id-sample.png")

/** Below 900px the primary action is a second, docked copy of the button. */
function primary(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true }).filter({ visible: true })
}

async function signIn(page: Page) {
  await page.goto("/account?demo=1")
  await expect(page.getByRole("heading", { name: "My Vault" })).toBeVisible()
  await page.getByLabel("Email").fill(DEMO_EMAIL)
  await page.getByRole("button", { name: "Send me a code" }).click()
  await page.getByLabel("Code", { exact: true }).fill(DEMO_CODE)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("heading", { name: "My card" })).toBeVisible()
}

test.describe("signing in", () => {
  test("takes an emailed code and lands on the card", async ({ page }) => {
    await signIn(page)

    // The card is the counter's own component, QR and all.
    await expect(
      page.getByRole("img", { name: "Guild card QR for Jasmine Okafor" })
    ).toBeVisible()
    await expect(page.getByTestId("portal-credit")).toHaveText("£45.00")
    await expect(page.getByTestId("portal-points")).toHaveText("2,180")
  })

  test("takes a code pasted with a space in the middle", async ({ page }) => {
    await page.goto("/account?demo=1")
    await page.getByRole("button", { name: "Send me a code" }).click()
    const field = page.getByLabel("Code", { exact: true })
    await field.fill("4821 3976")
    await expect(field).toHaveValue(DEMO_CODE)
  })

  test("says what to do when the code does not match", async ({ page }) => {
    await page.goto("/account?demo=1")
    await page.getByRole("button", { name: "Send me a code" }).click()
    await page.getByLabel("Code", { exact: true }).fill("11112222")
    await page.getByRole("button", { name: "Sign in" }).click()
    await expect(page.getByRole("alert")).toContainText("Check it, or send another")
  })

  test("holds 'Send another' back for a minute", async ({ page }) => {
    await page.goto("/account?demo=1")
    await page.getByRole("button", { name: "Send me a code" }).click()
    await expect(page.getByRole("button", { name: "Send another" })).toBeDisabled()
    await expect(page.getByText(/Ready in \d+ seconds?/)).toBeVisible()
  })

  test("leaves a staff session on the same browser alone", async ({ page }) => {
    // Sign in at the counter first, then into My Vault in the same tab.
    await page.goto("/login?demo=1")
    await page.getByLabel("Email").fill("demo@ggentertainment.co.uk")
    await page.getByLabel("Password").fill("ggvault-demo")
    await page.getByRole("button", { name: "Sign in" }).click()
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()

    await signIn(page)

    // The counter is still signed in: its guard would bounce to /login.
    await page.goto("/counter")
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()
  })
})

test.describe("quotes", () => {
  test("shows the offer, its timeline and accepts it", async ({ page }) => {
    await signIn(page)
    await page.goto("/account/quotes")

    await expect(page.getByRole("heading", { name: "Quotes" })).toBeVisible()
    await expect(page.getByText("Waiting on you")).toBeVisible()

    await page.getByRole("link", { name: /Offer made/ }).first().click()
    await expect(page.getByTestId("quote-offer-total")).toHaveText("£42.00")

    // The timeline says where it is, in words.
    const current = page.locator('[aria-current="step"]')
    await expect(current).toContainText("Offer made")
    await expect(current).toContainText("This offer holds until")

    await primary(page, "Accept the offer").click()
    const sheet = page.getByRole("dialog", { name: "Accept this offer" })
    await expect(sheet).toContainText("£42.00")
    await sheet.getByRole("button", { name: "Accept", exact: true }).click()

    await expect(page.getByRole("dialog")).toBeHidden()
    await expect(page.locator('[aria-current="step"]')).toContainText("Accepted")
  })

  test("sends photos for a new quote and shows it as sent", async ({ page }) => {
    await signIn(page)
    await page.goto("/account/quotes/new")

    await expect(page.getByRole("heading", { name: "Get a quote" })).toBeVisible()
    await expect(primary(page, "Send for a quote")).toBeDisabled()

    await page.getByTestId("quote-photo-input").setInputFiles(PHOTO)
    await expect(page.getByText("1 of 20 added")).toBeVisible()
    await expect(page.getByRole("img", { name: "Photo 1" })).toBeVisible()

    await page.getByLabel("Message").fill("Two boxes of Pokemon and a Game Boy.")
    await page.getByRole("button", { name: "Post it" }).click()
    await expect(page.getByText(/at your own risk/)).toBeVisible()

    await primary(page, "Send for a quote").click()

    await expect(page.getByRole("heading", { name: "Quote", exact: true })).toBeVisible()
    await expect(page.locator('[aria-current="step"]')).toContainText("Sent")
  })

  test("answers a message on the thread", async ({ page }) => {
    await signIn(page)
    await page.goto("/account/quotes")
    await page.getByRole("link", { name: /Offer made/ }).first().click()

    await page.getByLabel("Reply").fill("Coming in on Saturday morning.")
    await page.getByRole("button", { name: "Send message" }).click()
    await expect(page.getByText("Coming in on Saturday morning.")).toBeVisible()
  })
})

test.describe("want list", () => {
  test("says how long a matched card is held for", async ({ page }) => {
    await signIn(page)
    await page.goto("/account/wants")

    const held = page.getByTestId("want-row").first()
    await expect(held).toContainText("Charizard ex")
    await expect(held).toContainText(/Held for you until \d+ \w+, \d\d:\d\d/)
    await expect(held).toContainText("Up to £250.00")
  })

  test("adds a card and takes one off the list", async ({ page }) => {
    await signIn(page)
    await page.goto("/account/wants")

    // The demo list is three rows; waiting for them stops the count below
    // being taken while the screen is still loading.
    await expect(page.getByTestId("want-row")).toHaveCount(3)
    const before = await page.getByTestId("want-row").count()

    await primary(page, "Add a card").click()
    const sheet = page.getByRole("dialog", { name: "Add a card" })
    await sheet.getByLabel("Card").fill("Mew")
    await sheet.getByRole("option", { name: /Mew ex/ }).click()
    await sheet.getByLabel("Most you would pay").fill("60.00")
    await sheet.getByRole("button", { name: "Add to my list" }).click()

    await expect(page.getByTestId("want-row")).toHaveCount(before + 1)
    await expect(page.getByTestId("want-row").first()).toContainText("Up to £60.00")

    await page
      .getByTestId("want-row")
      .first()
      .getByRole("button", { name: "Remove" })
      .click()
    await expect(page.getByTestId("want-row")).toHaveCount(before)
  })
})

test.describe("credit and trade-ins", () => {
  test("shows the balance and the rows behind it", async ({ page }) => {
    await signIn(page)
    await page.goto("/account/credit")

    await expect(page.getByTestId("credit-balance")).toHaveText("£45.00")
    await expect(page.getByText("Sold to us")).toBeVisible()
    await expect(page.getByText("Spent in the shop")).toBeVisible()
    await expect(page.getByText("- £15.00")).toBeVisible()
  })

  test("opens a trade-in and shows what was sold and paid", async ({ page }) => {
    await signIn(page)
    await page.goto("/account/trade-ins")

    await expect(page.getByRole("heading", { name: "My trade-ins" })).toBeVisible()
    await page.getByRole("link", { name: /GG-BI-000061/ }).click()

    await expect(page.getByText("Pidgeot ex 113/191")).toBeVisible()
    await expect(page.getByText("£42.00")).toBeVisible()
  })
})

test.describe("notifications", () => {
  test("counts the unread ones in the nav and clears them on open", async ({ page }) => {
    await signIn(page)

    const bell = page.getByRole("link", { name: /Notifications, 2 unread/ })
    await expect(bell).toBeVisible()
    await bell.click()

    await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible()
    await expect(page.getByText("Your quote offer, £42.00")).toBeVisible()

    await expect(
      page.getByRole("link", { name: "Notifications, none unread" })
    ).toBeVisible()
  })
})

test.describe("profile and privacy", () => {
  test("summarises the privacy notice in a sheet", async ({ page }) => {
    await signIn(page)
    await page.goto("/account/me")

    await page.getByRole("button", { name: "How we use your data" }).click()
    const sheet = page.getByRole("dialog", { name: "How we use your data" })
    await expect(sheet).toContainText("six years")
    await expect(sheet).toContainText("twelve months")
    await expect(sheet).toContainText("90 days")
    await expect(sheet).toContainText("Information Commissioner's Office")
  })

  test("refuses to delete an account that still holds store credit", async ({ page }) => {
    await signIn(page)
    await page.goto("/account/me")

    await page.getByRole("button", { name: "Delete my account" }).click()
    const sheet = page.getByRole("dialog", { name: "Delete my account" })
    await expect(sheet).toContainText("six years")
    await expect(sheet).toContainText(
      "You still have £45.00 store credit. Use it or ask the shop to pay it out first."
    )

    await sheet.getByLabel("Type DELETE to confirm").fill("DELETE")
    await expect(
      sheet.getByRole("button", { name: "Delete my account" })
    ).toBeDisabled()
  })

  test("says where the ID stands, and that the email is the sign-in", async ({
    page,
  }) => {
    await signIn(page)
    await page.goto("/account/me")

    await expect(page.getByText(/photo ID is on file and in date/)).toBeVisible()
    await expect(page.getByText(DEMO_EMAIL)).toBeVisible()
    await expect(page.getByText(/This is how you sign in/)).toBeVisible()
  })

  test("signs out and puts the sign-in screen back", async ({ page }) => {
    await signIn(page)
    await page.goto("/account/me")

    await page.getByRole("button", { name: "Sign out" }).click()
    await expect(page.getByRole("heading", { name: "My Vault" })).toBeVisible()
    await expect(page.getByLabel("Email")).toBeVisible()
  })
})

test.describe("the card landing", () => {
  test("never names anybody before a sign-in", async ({ page }) => {
    await page.goto(`/c/${DEMO_QR_TOKEN}?demo=1`)

    await expect(page.getByRole("heading", { name: "Guild card" })).toBeVisible()
    await expect(
      page.getByText("This card belongs to a GG Guild member.")
    ).toBeVisible()
    await expect(page.getByText("Jasmine")).toHaveCount(0)
    await expect(page.getByRole("link", { name: "Sign in to My Vault" })).toBeVisible()
  })

  test("sends the customer whose card it is to their own card", async ({ page }) => {
    await signIn(page)
    await page.goto(`/c/${DEMO_QR_TOKEN}`)
    await expect(page.getByRole("heading", { name: "My card" })).toBeVisible()
  })

  test("sends a signed-in staff member to the counter's customer page", async ({
    page,
  }) => {
    await page.goto("/login?demo=1")
    await page.getByLabel("Email").fill("demo@ggentertainment.co.uk")
    await page.getByLabel("Password").fill("ggvault-demo")
    await page.getByRole("button", { name: "Sign in" }).click()
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()

    await page.goto(`/c/${DEMO_QR_TOKEN}`)
    await expect(page.getByRole("heading", { name: "Jasmine Okafor" })).toBeVisible()
  })

  test("says what to do for a link that is not a card", async ({ page }) => {
    await page.goto("/c/not-a-real-token?demo=1")
    await expect(page.getByRole("heading", { name: "Card not found" })).toBeVisible()
  })
})

test.describe("the guard", () => {
  test("bounces a signed-out visit and comes back to it", async ({ page }) => {
    await page.goto("/account/wants?demo=1")
    await expect(page.getByRole("heading", { name: "My Vault" })).toBeVisible()

    await page.getByLabel("Email").fill(DEMO_EMAIL)
    await page.getByRole("button", { name: "Send me a code" }).click()
    await page.getByLabel("Code", { exact: true }).fill(DEMO_CODE)
    await page.getByRole("button", { name: "Sign in" }).click()

    await expect(page.getByRole("heading", { name: "Want list" })).toBeVisible()
  })
})
