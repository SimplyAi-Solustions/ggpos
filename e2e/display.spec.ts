import { expect, test, type BrowserContext, type Page } from "@playwright/test"

import { buildCode } from "../packages/shared/src/sku"

/**
 * The customer-facing screen, driven from two pages in one browser context:
 * the counter on one, the tablet on the other.
 *
 * In demo mode the two talk through the state the browser itself holds for
 * the origin, which is what `display_state` and PocketBase realtime are
 * behind a server. So this exercises the same publish, the same subscribe
 * and the same accept the shop will run, without one.
 *
 * Playwright's two projects run the file at 1440 and at 390: the tablet is
 * a landscape screen in the shop, but a screen that breaks at 390 is broken.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

/** The demo Charizard, at £324.99, Jasmine's card and her £5 reward. */
const DEMO_SKU = buildCode("single", "7F3K2")
const JASMINE = "GGC-4K7M2S"
const MONEY_OFF = buildCode("voucher", "3H7K9")

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
  // Some actions are offered in two groups (the shortcut row and the
  // section), and either one goes to the same screen.
  await palette.getByText(action, { exact: true }).first().click()
  await expect(palette).toBeHidden()
}

/** Switches the display on in Settings, which is what gates every publish. */
async function switchDisplayOn(page: Page) {
  await go(page, "Settings")
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible()
  await page.getByRole("switch", { name: "Use the customer display" }).click()
  await expect(page.getByText("On the counter")).toBeVisible()
  await primary(page, "Save settings").click()
  await expect(page.getByTestId("settings-saved")).toBeVisible()
}

/** The palette's buy-in entry opens the list; the wizard is one press on. */
async function startBuyIn(page: Page) {
  await go(page, "New buy-in")
  await expect(page.getByRole("heading", { name: "Trade" })).toBeVisible()
  await primary(page, "New buy-in").click()
  await expect(page.getByRole("heading", { name: "Buy-in" })).toBeVisible()
}

/** The tablet: a second page in the same context, signed in already. */
async function openTablet(context: BrowserContext): Promise<Page> {
  const tablet = await context.newPage()
  await tablet.goto("/display?demo=1")
  return tablet
}

test.describe("the customer display", () => {
  test("shows the shop's own screen while nothing is on it", async ({ context }) => {
    const counter = await context.newPage()
    await signIn(counter)

    const tablet = await openTablet(context)
    await expect(tablet.getByTestId("display-idle")).toBeVisible()
    await expect(tablet.getByRole("heading", { name: "Join GG Guild" })).toBeVisible()
    await expect(tablet.getByText("Scan it, or join at the counter")).toBeVisible()
    await expect(tablet.getByRole("img", { name: "Join GG Guild" })).toBeVisible()
    await expect(tablet.getByTestId("display-ticker")).toBeVisible()

    // Nothing to press, and nowhere to go.
    await expect(tablet.getByRole("button")).toHaveCount(0)
    await expect(tablet.getByRole("navigation")).toHaveCount(0)
  })

  test("follows the basket at the till", async ({ context }) => {
    const counter = await context.newPage()
    await signIn(counter)
    await switchDisplayOn(counter)

    const tablet = await openTablet(context)
    await expect(tablet.getByTestId("display-idle")).toBeVisible()

    await go(counter, "Sell")
    const field = counter.getByTestId("sell-scan-field")
    await field.fill(DEMO_SKU.display)
    await field.press("Enter")
    await expect(counter.getByTestId("basket")).toContainText("Charizard ex")

    // The publish is debounced, so the tablet catches up a moment later.
    await expect(tablet.getByTestId("display-sale")).toBeVisible()
    await expect(tablet.getByText("Charizard ex")).toBeVisible()
    await expect(tablet.getByTestId("display-total")).toHaveText("£324.99")
    // No customer on the sale yet, so no name and no points.
    await expect(tablet.getByTestId("display-customer")).toHaveCount(0)

    // Her card, and the tablet says what the sale earns her.
    await field.fill(JASMINE)
    await field.press("Enter")
    await expect(counter.getByTestId("basket-customer")).toContainText("Jasmine")
    await expect(tablet.getByTestId("display-customer")).toHaveText("Jasmine O.")
    await expect(tablet.getByTestId("display-points")).toContainText("Earns")
    // A first name and a last initial: the tablet faces the shop.
    await expect(tablet.getByText("Okafor")).toHaveCount(0)

    // Her reward comes off the basket, and the customer can read what came
    // off and what it was called.
    await field.fill(MONEY_OFF.display)
    await field.press("Enter")
    await expect(counter.getByText("£5 off a single applied")).toBeVisible()
    await expect(tablet.getByTestId("display-discount")).toHaveText("-£5.00")
    await expect(tablet.getByTestId("display-sale")).toContainText("£5 off a single")
    await expect(tablet.getByTestId("display-total")).toHaveText("£319.99")

    // Emptying the basket puts the shop's own screen back.
    await counter.getByRole("button", { name: "Remove Charizard ex" }).click()
    await expect(tablet.getByTestId("display-idle")).toBeVisible()
  })

  test("takes the customer's acceptance of a buy-in offer", async ({ context }) => {
    const counter = await context.newPage()
    await signIn(counter)
    await switchDisplayOn(counter)

    const tablet = await openTablet(context)
    await expect(tablet.getByTestId("display-idle")).toBeVisible()

    // ---- A buy-in as far as the offer -----------------------------------
    await startBuyIn(counter)
    await counter.getByLabel("Find them").fill("Jasmine")
    await counter.getByRole("button", { name: /Jasmine Okafor/ }).click()
    await primary(counter, "Add items").click()

    await counter.getByRole("button", { name: "Retro", exact: true }).click()
    await counter.getByLabel("Title").fill("Mario Kart 64, boxed")
    await counter.getByRole("button", { name: "Add line" }).click()
    await counter.getByLabel("Market value for Mario Kart 64, boxed").fill("40")
    const offered = await counter.getByTestId("total-credit").innerText()
    await primary(counter, "Make the offer").click()

    // ---- The signature waits for the customer ---------------------------
    await expect(counter.getByTestId("tile-credit")).toBeVisible()
    await expect(counter.getByTestId("signature-pad")).toHaveCount(0)
    await primary(counter, "Complete buy-in").click()
    await expect(
      counter.getByText(
        "Send the offer to the display and wait for the customer to accept it, or skip the display."
      )
    ).toBeVisible()

    // ---- Show customer --------------------------------------------------
    await counter.getByRole("button", { name: "Show customer" }).click()
    await expect(counter.getByTestId("handoff-state")).toHaveText(
      "On the display now. It is signed here once the customer accepts it."
    )

    await expect(tablet.getByTestId("display-buyin")).toBeVisible()
    await expect(tablet.getByRole("heading", { name: "Our offer" })).toBeVisible()
    await expect(tablet.getByText("Mario Kart 64, boxed")).toBeVisible()
    // What the tablet shows is exactly what the counter offered.
    await expect(tablet.getByTestId("display-offer")).toHaveText(offered)
    await expect(tablet.getByText("Paid in store credit")).toBeVisible()

    // ---- Accepted on the tablet, which the counter learns about ---------
    await tablet.getByTestId("display-accept").click()
    await expect(tablet.getByTestId("display-accepted")).toBeVisible()
    await expect(tablet.getByText("Thanks, now sign at the counter.")).toBeVisible()

    await expect(counter.getByTestId("handoff-state")).toHaveText(
      "Accepted on the display. Take their signature below."
    )
    await expect(counter.getByTestId("signature-pad")).toBeVisible()
    await expect(
      counter.getByRole("button", { name: "Skip the display" })
    ).toBeHidden()
  })

  test("lets the counter skip the display for a verbal acceptance", async ({
    context,
  }) => {
    const counter = await context.newPage()
    await signIn(counter)
    await switchDisplayOn(counter)

    await startBuyIn(counter)
    await counter.getByLabel("Find them").fill("Jasmine")
    await counter.getByRole("button", { name: /Jasmine Okafor/ }).click()
    await primary(counter, "Add items").click()
    await counter.getByRole("button", { name: "Retro", exact: true }).click()
    await counter.getByLabel("Title").fill("Mario Kart 64, boxed")
    await counter.getByRole("button", { name: "Add line" }).click()
    await counter.getByLabel("Market value for Mario Kart 64, boxed").fill("40")
    await primary(counter, "Make the offer").click()

    await expect(counter.getByTestId("signature-pad")).toHaveCount(0)
    await counter.getByRole("button", { name: "Skip the display" }).click()
    await expect(counter.getByTestId("handoff-state")).toHaveText(
      "Taken verbally. Take their signature below."
    )
    await expect(counter.getByTestId("signature-pad")).toBeVisible()
  })
})
