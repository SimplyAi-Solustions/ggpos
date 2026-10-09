import { expect, test, type Page } from "@playwright/test"

import { buildCode } from "../packages/shared/src/sku"

/**
 * The GG Guild at the counter: the admin's rules with their live preview, a
 * paid plan pinning a tier, a perk coming off a wallet, a scanned voucher
 * marked used and spent on a ticket, and an adjustment behind a password.
 *
 * Driven against the demo stores, which refuse what the routes refuse in the
 * same sentences, so this proves the screens rather than a lenient fixture.
 * Those stores live in memory for the tab, so every step after sign-in is a
 * click: a reload would put the demo shop back to its seed. Playwright's two
 * projects run the file at 1440 and at 390.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

/** The demo Charizard, at £324.99. */
const DEMO_SKU = buildCode("single", "7F3K2")
/** Jasmine's £5 money-off reward, and Tom's free sleeve pack. */
const MONEY_OFF = buildCode("voucher", "3H7K9")
const FREE_ITEM = buildCode("voucher", "8P2RT")
/** Jasmine's own card code, which is also her referral code, and Tom's. */
const JASMINE_CODE = "GGC-4K7M2S"
const TOM_CODE = buildCode("customer", "9QB3X").display

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
  // By name, because a sheet that is still playing its closing animation is
  // also a dialog for a moment.
  const palette = page.getByRole("dialog", { name: "Commands and catalogue search" })
  await expect(palette).toBeVisible()
  // Some actions are offered in two groups (the shortcut row and the
  // section), and either one goes to the same screen.
  await palette.getByText(action, { exact: true }).first().click()
  await expect(palette).toBeHidden()
}

/** The till, whatever the palette calls it. */
async function goTill(page: Page) {
  await page.keyboard.press("ControlOrMeta+k")
  const palette = page.getByRole("dialog", { name: "Commands and catalogue search" })
  await expect(palette).toBeVisible()
  await palette.getByText(/^(Sell|Till)$/).first().click()
  await expect(palette).toBeHidden()
  await expect(page.getByTestId("till")).toBeVisible()
}

/** A scan into the till's field, from whichever of its tabs is in front. */
async function tillScan(page: Page, code: string) {
  const items = page.getByRole("tab", { name: /^(Items|Pay|Done)$/ })
  if (await items.isVisible()) await items.click()
  const field = page.getByTestId("till-scan-field")
  await field.fill(code)
  await field.press("Enter")
}

/** Below 900px the ticket is a tab of its own. */
async function showTicket(page: Page) {
  // The till first: the tab is only there once it has drawn, and checking
  // before then would skip the tap on a phone.
  await expect(page.getByTestId("till")).toBeVisible()
  const tab = page.getByTestId("till-ticket-tab")
  if (await tab.isVisible()) await tab.click()
}

/** Opens a customer's profile the way staff do, through the list. */
async function openCustomer(page: Page, name: string) {
  await go(page, "Customers")
  await page.getByLabel("Search customers").fill(name)
  await page.getByRole("link", { name, exact: true }).click()
  await expect(page.getByRole("heading", { name })).toBeVisible()
}

/** The counter's one step-up dialog, shared with refunds and buy-ins. */
async function confirmPassword(page: Page) {
  const dialog = page.getByRole("dialog", {
    name: "Confirm your password to continue",
  })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel("Password").fill(DEMO_PASSWORD)
  await dialog.getByRole("button", { name: "Continue" }).click()
  await expect(dialog).toBeHidden()
}

test.describe("the Guild at the counter", () => {
  test("edits an offer in its sheet, saves it on its own, and the preview prices it", async ({
    page,
  }) => {
    await signIn(page)
    await go(page, "Loyalty")
    await expect(page.getByRole("heading", { name: "Loyalty" })).toBeVisible()

    // The seed: £30.00 of sealed on a Saturday, no tier. Ten points a pound
    // is 300, the Saturday offer doubles it, the sealed bonus adds 250.
    const total = page.getByTestId("preview-total")
    await expect(total).toHaveText("850")
    await expect(page.getByTestId("preview-sentence")).toHaveText(
      "A £30.00 sealed sale on a Saturday for a customer with no tier earns 850 points."
    )

    // Every offer reads as a sentence, with its example under it.
    const offers = page.getByTestId("loyalty-offers")
    await expect(offers).toContainText(
      "250 bonus points when they buy anything, sealed only, on £30.00 or more"
    )

    // ---- Edit the Saturday offer in its sheet ---------------------------
    await offers.getByRole("button", { name: /2 times points on Saturdays/ }).click()
    const sheet = page.getByRole("dialog", { name: "Offer" })
    await expect(sheet).toBeVisible()
    await sheet.getByLabel("Times points").fill("3")
    // The example answers as the blank is filled in.
    await expect(sheet.getByTestId("offer-sheet-example")).toHaveText(
      "A £30.00 sale on a Saturday earns 900 points."
    )
    await sheet.getByRole("button", { name: "Save offer" }).click()
    await expect(sheet).toBeHidden()

    // Saved on its own: the list and the preview both price it now, and
    // nothing is left waiting on the programme's Save.
    await expect(offers).toContainText("3 times points on Saturdays")
    await expect(total).toHaveText("1,150")
    await expect(page.getByTestId("loyalty-dirty")).toBeHidden()

    // A different day is a different answer, and the sentence says which.
    await page.getByLabel("Day of the week").click()
    await page.getByRole("option", { name: "Tuesday" }).click()
    await expect(total).toHaveText("550")
    await expect(page.getByTestId("preview-sentence")).toContainText("on a Tuesday")

    // Switched off from the list, it stops paying at once.
    await page.getByRole("switch", { name: "3 times points on Saturdays: on" }).click()
    await page.getByLabel("Day of the week").click()
    await page.getByRole("option", { name: "Saturday" }).click()
    await expect(total).toHaveText("550")
  })

  test("records a paid plan and pins the customer's tier", async ({ page }) => {
    await signIn(page)

    // Tom is a Member on his points alone.
    await openCustomer(page, "Tom Bradbury")
    await expect(page.getByTestId("guild-tier")).toHaveText("Member")

    await go(page, "Loyalty")
    await page.getByRole("button", { name: "Record a plan" }).click()
    const sheet = page.getByRole("dialog", { name: "Record a plan" })
    await expect(sheet).toBeVisible()

    await sheet.getByLabel("Customer").fill("Tom Bradbury")
    await sheet.getByTestId("customer-hit").first().click()
    await sheet.getByLabel("The tier this plan grants").click()
    await page.getByRole("option", { name: "Guild Pass", exact: true }).click()
    await sheet.getByLabel("Months").fill("12")
    await sheet.getByLabel("Paid").fill("60.00")
    await sheet.getByRole("button", { name: "Save plan" }).click()
    await expect(sheet).toBeHidden()

    const list = page.getByTestId("memberships")
    await expect(list).toContainText("Tom Bradbury")
    await expect(list).toContainText("£60.00")

    // The plan pins the tier, which is what the profile now shows.
    await openCustomer(page, "Tom Bradbury")
    await expect(page.getByTestId("guild-tier")).toHaveText("Guild Pass")
    await expect(page.getByTestId("guild-section")).toContainText("Renews")

    // And the till prices against the tier he now holds, with its perks.
    await goTill(page)
    await tillScan(page, TOM_CODE)
    await showTicket(page)
    await expect(page.getByTestId("ticket-customer")).toContainText("Tom Bradbury")
    await expect(page.getByTestId("ticket-customer")).toContainText("Guild Pass")
  })

  test("uses a perk and moves the counter", async ({ page }) => {
    await signIn(page)
    // Callum is on the paid Guild Pass with one free entry already used.
    await openCustomer(page, "Callum Reeve")
    await expect(page.getByTestId("guild-tier")).toHaveText("Guild Pass")

    const entries = page.getByTestId("perk-free_event_entries")
    await expect(entries).toHaveText("1 of 2 left this month")

    const useOne = page
      .getByTestId("perk-wallet")
      .getByRole("button", { name: "Use one" })
      .first()
    await useOne.click()

    await expect(entries).toHaveText("0 of 2 left this month")
    await expect(
      page.getByText("Free event entries: 0 left this month.")
    ).toBeVisible()
    // Spent, so it cannot be used again this month.
    await expect(useOne).toBeDisabled()
  })

  test("marks a scanned voucher used, and sends a money-off one to the till", async ({
    page,
  }) => {
    await signIn(page)
    await go(page, "Scan")
    await expect(page.getByRole("heading", { name: "Scan" })).toBeVisible()

    const field = page.getByTestId("scan-field")
    await field.fill(FREE_ITEM.display)
    await field.press("Enter")

    const sheet = page.getByTestId("voucher-sheet")
    await expect(sheet).toBeVisible()
    await expect(sheet).toContainText("Sleeve pack")
    await expect(sheet).toContainText("Tom Bradbury")
    await expect(page.getByTestId("voucher-status")).toHaveText("Open")

    await page.getByRole("button", { name: "Mark as used" }).click()
    await expect(page.getByText("Marked used. Hand it over.")).toBeVisible()
    await expect(page.getByTestId("voucher-status")).toHaveText("Used")
    // The sheet has a footer action and a corner icon, both named Close.
    await page.getByRole("button", { name: "Close" }).first().click()

    // A money-off reward is spent on a basket instead, so the counter action
    // is not even offered.
    await field.fill(MONEY_OFF.display)
    await field.press("Enter")
    await expect(page.getByTestId("voucher-sheet")).toContainText("£5 off a single")
    await expect(page.getByRole("button", { name: "Use on a sale" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Mark as used" })).toBeHidden()
  })

  test("takes a money-off voucher through to the till's ticket", async ({ page }) => {
    await signIn(page)

    // A reward comes off a sale, so there has to be one to take it off.
    await goTill(page)
    await tillScan(page, DEMO_SKU.display)
    await expect(page.getByText("Charizard ex added")).toBeVisible()

    await go(page, "Scan")
    const field = page.getByTestId("scan-field")
    await field.fill(MONEY_OFF.display)
    await field.press("Enter")
    await expect(page.getByTestId("voucher-sheet")).toBeVisible()
    await page.getByRole("button", { name: "Use on a sale" }).click()

    // The till comes back with the reward's own customer attached and the
    // five pounds off the ticket.
    await expect(page.getByTestId("till")).toBeVisible()
    await expect(page.getByText("£5 off a single applied")).toBeVisible()
    await showTicket(page)
    await expect(page.getByTestId("ticket-customer")).toContainText("Jasmine Okafor")
    await expect(
      page.getByTestId("ticket-total").or(page.getByTestId("till-dock-total"))
    ).toHaveText("£319.99")
  })

  test("cancels a voucher and puts the points back", async ({ page }) => {
    await signIn(page)
    await go(page, "Scan")

    const field = page.getByTestId("scan-field")
    await field.fill(FREE_ITEM.display)
    await field.press("Enter")
    await expect(page.getByTestId("voucher-sheet")).toContainText("Sleeve pack")

    await page.getByRole("button", { name: "Cancel and return the points" }).click()
    await expect(
      page.getByText("Cancelled. The points are back on Tom Bradbury's account.")
    ).toBeVisible()
    await expect(page.getByTestId("voucher-status")).toHaveText("Cancelled")
    await page.getByRole("button", { name: "Close" }).first().click()

    // The 800 points the sleeve pack cost are on his record again.
    await openCustomer(page, "Tom Bradbury")
    await expect(page.getByTestId("customer-points")).toHaveText("1,140")
  })

  test("takes a referral code on a new customer, and refuses one nobody holds", async ({
    page,
  }) => {
    await signIn(page)
    await go(page, "New customer")
    await expect(page.getByRole("heading", { name: "New customer" })).toBeVisible()

    await page.getByLabel("Name", { exact: true }).fill("Priya Sandhu")
    await page.getByLabel("Referred by").fill(buildCode("customer", "ZZZZZ").display)
    await primary(page, "Save customer").click()

    // The server is the only thing that can say whether a code is anybody's,
    // and its sentence lands under the field it belongs to.
    await expect(
      page.getByText(/No customer has the code GGC-ZZZZZ/)
    ).toBeVisible()
    await expect(page.getByRole("heading", { name: "New customer" })).toBeVisible()

    await page.getByLabel("Referred by").fill(JASMINE_CODE)
    await primary(page, "Save customer").click()

    // The card exists, and the referral is waiting on Jasmine's record.
    await expect(page.getByRole("heading", { name: "Priya Sandhu" })).toBeVisible()
    await openCustomer(page, "Jasmine Okafor")
    await expect(page.getByTestId("guild-section")).toContainText("1 earned, 2 waiting")
  })

  test("adjusts points behind a password, and never below zero", async ({ page }) => {
    await signIn(page)
    await openCustomer(page, "Callum Reeve")

    await page
      .getByTestId("guild-section")
      .getByRole("button", { name: "Adjust points" })
      .click()
    const sheet = page.getByRole("dialog", { name: "Adjust points" })
    await expect(sheet).toBeVisible()

    // Callum holds 90 points, so 200 off is refused before the password is
    // ever asked for.
    await sheet.getByLabel("Points").fill("-200")
    await sheet.getByLabel("Reason").fill("Testing the floor on a balance")
    await sheet.getByRole("button", { name: "Adjust points" }).click()
    await expect(
      sheet.getByText(
        "That would take them to -110 points. The most you can remove is 90."
      )
    ).toBeVisible()

    await sheet.getByLabel("Points").fill("250")
    await sheet.getByLabel("Reason").fill("Goodwill after a mis-priced sale")
    await sheet.getByRole("button", { name: "Adjust points" }).click()

    await confirmPassword(page)
    await expect(sheet).toBeHidden()
    await expect(page.getByText("Adjusted. They now hold 340 points.")).toBeVisible()
  })
})
