import { expect, test, type Page } from "@playwright/test"

import { buildCode } from "../packages/shared/src/sku"

/**
 * Selling, the drawer and the labels, driven against the demo fixtures.
 *
 * The demo stores live in memory for the tab, exactly as the item store Add
 * stock writes to does, so this walks the counter the way staff would: every
 * step after sign-in is a click, never a fresh page load.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

/** The demo Charizard, at £324.99. */
const DEMO_SKU = buildCode("single", "7F3K2")

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
  await palette.getByText(action, { exact: true }).click()
  await expect(palette).toBeHidden()
}

/**
 * Arms the demo's one-shot race: the next sale refuses the way one does
 * when an item has been sold on the other till, which is the refusal a card
 * payment can only meet after the money has moved.
 */
async function armRace(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("gg-demo-sale", "race")
  })
}

async function scan(page: Page, code: string) {
  const field = page.getByTestId("sell-scan-field")
  await field.fill(code)
  await field.press("Enter")
}

test.describe("selling at the counter", () => {
  test("opens the drawer, sells, undoes, sells again and closes the drawer", async ({
    page,
  }) => {
    await signIn(page)

    // ---- Open a cash session -------------------------------------------
    await go(page, "Cash session")
    await expect(page.getByRole("heading", { name: "Cash" })).toBeVisible()
    await page.getByLabel("Float").fill("100.00")
    await primary(page, "Open session").click()
    await expect(page.getByTestId("cash-expected")).toHaveText("£100.00")

    // ---- Sell the demo card for cash ------------------------------------
    await go(page, "Sell")
    await expect(page.getByRole("heading", { name: "Sell" })).toBeVisible()
    await expect(page.getByText("Nothing in the basket. Scan an item to start.")).toBeVisible()

    await scan(page, DEMO_SKU.display)
    await expect(page.getByTestId("basket")).toContainText("Charizard ex")
    await expect(page.getByTestId("sell-total")).toHaveText("£324.99")

    await page.getByRole("button", { name: "Cash", exact: true }).click()
    await primary(page, "Mark sold").click()

    const done = page.getByTestId("sale-done")
    await expect(done).toBeVisible()
    await expect(done).toContainText(/GG-S-\d{6}/)
    await expect(done).toContainText("£324.99")

    // ---- Undo it, which is a refund behind a password -------------------
    const toast = page.getByTestId("undo-toast")
    await expect(toast).toBeVisible()
    await toast.getByRole("button", { name: "Undo" }).click()

    const stepUp = page.getByRole("dialog", {
      name: "Confirm your password to continue",
    })
    await expect(stepUp).toBeVisible()
    await stepUp.getByLabel("Password").fill(DEMO_PASSWORD)
    await stepUp.getByRole("button", { name: "Continue" }).click()

    await expect(toast).toBeHidden()
    await expect(page.getByTestId("sale-done")).toBeHidden()

    // ---- Sell it again, this time on the card ---------------------------
    await scan(page, DEMO_SKU.display)
    await expect(page.getByTestId("basket")).toContainText("Charizard ex")
    await page.getByRole("button", { name: "SumUp card", exact: true }).click()
    await expect(page.getByTestId("sumup-amount")).toHaveText("£324.99")

    await primary(page, "Mark sold").click()
    await expect(page.getByTestId("sale-done")).toContainText(/GG-S-\d{6}/)

    // ---- The item page says it has gone ---------------------------------
    await go(page, "Stock")
    await expect(page.getByRole("heading", { name: "Stock" })).toBeVisible()
    await page.getByRole("button", { name: "Sold", exact: true }).click()
    await page
      .getByTestId("stock-row")
      .filter({ hasText: "Charizard ex" })
      .first()
      .click()

    await expect(page.getByTestId("item-sku")).toHaveText(DEMO_SKU.display)
    await expect(page.getByTestId("item-status")).toHaveText("Sold")
    await expect(page.getByTestId("item-price")).toHaveText("£324.99")

    // ---- Close the drawer against a count -------------------------------
    await go(page, "Cash session")
    // The cash sale was undone, so the drawer is back to its float.
    await expect(page.getByTestId("cash-expected")).toHaveText("£100.00")
    await page.getByLabel("Counted").fill("95.00")
    await expect(page.getByTestId("cash-variance")).toContainText("Short £5.00")
    await expect(page.getByTestId("cash-variance")).toContainText("In tolerance")

    await primary(page, "Close session").click()
    await expect(page.getByTestId("cash-closed")).toBeVisible()
    await expect(page.getByTestId("closed-variance")).toContainText("Short £5.00")
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

  test("asks where a split payment goes back instead of undoing it blind", async ({
    page,
  }) => {
    await signIn(page)

    await go(page, "Cash session")
    await page.getByLabel("Float").fill("100.00")
    await primary(page, "Open session").click()
    await expect(page.getByTestId("cash-expected")).toHaveText("£100.00")

    await go(page, "Sell")
    await scan(page, DEMO_SKU.display)
    await page.getByRole("button", { name: "Mixed", exact: true }).click()

    // A three-decimal amount is refused rather than quietly becoming nothing.
    await page.getByLabel("Cash").fill("100.005")
    await expect(page.getByText("Pounds and pence, for example 12.50.")).toBeVisible()

    await page.getByLabel("Cash").fill("100.00")
    await page.getByLabel("SumUp card").fill("224.99")
    await expect(page.getByTestId("sumup-amount")).toHaveText("£224.99")

    await primary(page, "Mark sold").click()
    const done = page.getByTestId("sale-done")
    await expect(done).toBeVisible()

    const toast = page.getByTestId("undo-toast")
    await expect(toast).toContainText("Split payment")
    await toast.getByRole("button", { name: "Undo" }).click()

    // The refund sheet, with the method chips, rather than a silent card refund.
    const sheet = page.getByRole("dialog").filter({ hasText: "Refund" })
    await expect(sheet).toBeVisible()
    await expect(sheet.getByRole("button", { name: "Store credit" })).toBeVisible()
    await expect(sheet.getByRole("button", { name: "Cash", exact: true })).toBeVisible()
  })

  test("takes the card payment on the reader and completes the sale", async ({
    page,
  }) => {
    await signIn(page)
    await go(page, "Sell")

    await scan(page, DEMO_SKU.display)
    await page.getByRole("button", { name: "SumUp card", exact: true }).click()
    await expect(page.getByTestId("sumup-amount")).toHaveText("£324.99")

    await page.getByTestId("take-card-payment").click()

    const sheet = page.getByTestId("card-payment-sheet")
    await expect(sheet).toBeVisible()
    await expect(sheet).toContainText("Counter Solo")
    await expect(sheet.getByTestId("card-payment-amount")).toHaveText("£324.99")
    await expect(sheet.getByTestId("card-payment-status")).toContainText(
      "Waiting for the reader."
    )

    // The reader answers, and the sale completes against that checkout.
    await expect(sheet).toBeHidden({ timeout: 15_000 })
    const done = page.getByTestId("sale-done")
    await expect(done).toBeVisible()
    await expect(done).toContainText(/GG-S-\d{6}/)
    await expect(done).toContainText("£324.99")
  })

  test("says why the card was declined, and offers another go", async ({ page }) => {
    // The demo reader declines the next card.
    await page.addInitScript(() => {
      window.localStorage.setItem("gg-demo-reader", "fail")
    })
    await signIn(page)
    await go(page, "Sell")

    await scan(page, DEMO_SKU.display)
    await page.getByRole("button", { name: "SumUp card", exact: true }).click()
    await page.getByTestId("take-card-payment").click()

    const sheet = page.getByTestId("card-payment-sheet")
    await expect(sheet.getByTestId("card-payment-status")).toContainText(
      "The card was declined.",
      { timeout: 15_000 }
    )
    await expect(sheet.getByRole("button", { name: "Try again" })).toBeVisible()

    // Nothing was sold, and the basket is still there to try again with.
    await expect(page.getByTestId("sale-done")).toBeHidden()
    // The footer's own Close, not the sheet's corner cross.
    await sheet.getByRole("button", { name: "Close" }).first().click()
    await expect(sheet).toBeHidden()
    await expect(page.getByTestId("basket")).toContainText("Charizard ex")
  })

  test("never loses a payment the reader took on a sale that would not complete", async ({
    page,
  }) => {
    // The one refusal the till cannot see coming: the item is sold on the
    // other counter between the card being taken and the sale going through.
    await armRace(page)
    await signIn(page)
    await go(page, "Sell")

    await scan(page, DEMO_SKU.display)
    await page.getByRole("button", { name: "SumUp card", exact: true }).click()
    await expect(page.getByTestId("sumup-amount")).toHaveText("£324.99")

    await page.getByTestId("take-card-payment").click()

    const sheet = page.getByTestId("card-payment-sheet")
    await expect(sheet.getByTestId("card-payment-status")).toContainText(
      "The customer has paid, and the sale did not go through.",
      { timeout: 15_000 }
    )
    await expect(sheet.getByTestId("card-payment-status")).toContainText(
      "That item was sold on the other till a moment ago."
    )
    // The SumUp transaction code, so it can be refunded in the app.
    await expect(sheet.getByTestId("card-payment-code")).toHaveText(/TEHY\d+/)
    await expect(sheet).toContainText("Refund it in the SumUp app")

    // Closing the sheet leaves the payment on the screen, not in the past.
    await sheet.getByRole("button", { name: "Back to the sale" }).click()
    await expect(sheet).toBeHidden()
    const held = page.getByTestId("card-payment-held")
    await expect(held).toContainText("Counter Solo")
    await expect(page.getByTestId("card-payment-held-reference")).toHaveText(
      /TEHY\d+/
    )

    // Walk off to the drawer and back: the payment is still on the screen.
    await go(page, "Cash session")
    await expect(page.getByLabel("Float")).toBeVisible()
    await go(page, "Sell")
    await expect(page.getByTestId("basket")).toContainText("Charizard ex")
    await expect(page.getByTestId("card-payment-held-reference")).toHaveText(
      /TEHY\d+/
    )

    // And the sale completes against that same payment.
    await primary(page, "Mark sold").click()
    await expect(page.getByTestId("sale-done")).toContainText(/GG-S-\d{6}/)
    await expect(page.getByTestId("card-payment-held")).toBeHidden()
  })

  test("has no way out but Cancel while the reader has the amount", async ({
    page,
  }) => {
    await signIn(page)
    await go(page, "Sell")

    await scan(page, DEMO_SKU.display)
    await page.getByRole("button", { name: "SumUp card", exact: true }).click()
    await page.getByTestId("take-card-payment").click()

    const sheet = page.getByTestId("card-payment-sheet")
    await expect(sheet.getByTestId("card-payment-status")).toContainText(
      "Waiting for the reader."
    )

    // The three ways a sheet is usually dismissed, none of which may leave
    // a customer paying with nothing watching.
    await expect(sheet.getByRole("button", { name: "Close" })).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(sheet).toBeVisible()
    await page.mouse.click(5, 5)
    await expect(sheet).toBeVisible()

    // And the payment still lands on the sale it was taken for.
    await expect(sheet).toBeHidden({ timeout: 15_000 })
    await expect(page.getByTestId("sale-done")).toContainText(/GG-S-\d{6}/)
  })

  test("will not offer another go at a reader busy with somebody else", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("gg-demo-reader", "busy")
    })
    await signIn(page)
    await go(page, "Sell")

    await scan(page, DEMO_SKU.display)
    await page.getByRole("button", { name: "SumUp card", exact: true }).click()
    await page.getByTestId("take-card-payment").click()

    const sheet = page.getByTestId("card-payment-sheet")
    await expect(sheet.getByTestId("card-payment-status")).toContainText(
      "The reader is busy with another payment. Finish or cancel that one first."
    )
    // Pressing it again would get the same answer, so it is not offered.
    await expect(sheet.getByRole("button", { name: "Try again" })).toHaveCount(0)
    await sheet.getByTestId("card-payment-close").click()
    await expect(sheet).toBeHidden()
  })

  test("uses a payment already made for the basket instead of asking twice", async ({
    page,
  }) => {
    // The reader answers with a payment this basket already made and no
    // sale has used, which is what the route does after a retry.
    await page.addInitScript(() => {
      window.localStorage.setItem("gg-demo-reader", "prepaid")
    })
    await signIn(page)
    await go(page, "Sell")

    await scan(page, DEMO_SKU.display)
    await page.getByRole("button", { name: "SumUp card", exact: true }).click()
    await page.getByTestId("take-card-payment").click()

    // Straight to finishing the sale: no second amount on the reader.
    const done = page.getByTestId("sale-done")
    await expect(done).toContainText(/GG-S-\d{6}/, { timeout: 15_000 })
    await expect(done).toContainText("£324.99")
  })

  test("refuses to spend a payment on a basket it was not taken for", async ({
    page,
  }) => {
    await armRace(page)
    await signIn(page)
    await go(page, "Sell")

    // Open a drawer first, so nothing about cash is in the way.
    await go(page, "Cash session")
    await page.getByLabel("Float").fill("100.00")
    await primary(page, "Open session").click()
    await expect(page.getByTestId("cash-expected")).toHaveText("£100.00")
    await go(page, "Sell")

    await scan(page, DEMO_SKU.display)
    await page.getByRole("button", { name: "SumUp card", exact: true }).click()
    await page.getByTestId("take-card-payment").click()
    await expect(page.getByTestId("card-payment-code")).toHaveText(/TEHY\d+/, {
      timeout: 15_000,
    })
    await page.getByRole("button", { name: "Back to the sale" }).click()

    // Now the card part changes underneath the payment that was taken.
    await page.getByRole("button", { name: "Mixed", exact: true }).click()
    await page.getByLabel("Cash").fill("24.99")
    await page.getByLabel("SumUp card").fill("300.00")
    await primary(page, "Mark sold").click()

    // The route's own sentence, with both figures in it, beside the payment
    // it is about.
    await expect(page.getByTestId("card-payment-held-reason")).toHaveText(
      "The reader took £324.99 but the card part of this sale is £300.00. Adjust the split or refund the difference from the SumUp app."
    )
    await expect(page.getByTestId("sale-done")).toBeHidden()
    // The payment is still on the screen, with its reference.
    await expect(page.getByTestId("card-payment-held-reference")).toHaveText(
      /TEHY\d+/
    )
  })

  test("puts a payment down only when a staff member says it was refunded", async ({
    page,
  }) => {
    await armRace(page)
    await signIn(page)
    await go(page, "Sell")

    await scan(page, DEMO_SKU.display)
    await page.getByRole("button", { name: "SumUp card", exact: true }).click()
    await page.getByTestId("take-card-payment").click()
    await expect(page.getByTestId("card-payment-code")).toHaveText(/TEHY\d+/, {
      timeout: 15_000,
    })
    await page.getByRole("button", { name: "Back to the sale" }).click()
    await expect(page.getByTestId("card-payment-held")).toBeVisible()

    // Removing the line clears the basket; the payment stays, because the
    // money is still on the customer's card.
    await page.getByTestId("basket").getByRole("button", { name: "Remove" }).click()
    await expect(page.getByTestId("card-payment-held")).toBeVisible()

    // The next customer's sale does not put it down either: it is still on
    // the first customer's card.
    await scan(page, DEMO_SKU.display)
    await page.getByRole("button", { name: "Cash", exact: true }).click()
    await go(page, "Cash session")
    await page.getByLabel("Float").fill("100.00")
    await primary(page, "Open session").click()
    await expect(page.getByTestId("cash-expected")).toHaveText("£100.00")
    await go(page, "Sell")
    await primary(page, "Mark sold").click()
    await expect(page.getByTestId("sale-done")).toBeVisible()
    await expect(page.getByTestId("card-payment-held")).toBeVisible()

    // Two presses to put it down, and the second one says what it means.
    await page.getByTestId("card-payment-refunded").click()
    await expect(
      page.getByText("Only put it down once the refund is through in the SumUp app.")
    ).toBeVisible()
    await page.getByTestId("card-payment-refunded-confirm").click()
    await expect(page.getByTestId("card-payment-held")).toBeHidden()
  })

  test("says what is wrong when cash is taken with no session open", async ({
    page,
  }) => {
    await signIn(page)
    await go(page, "Sell")

    await scan(page, DEMO_SKU.display)
    await page.getByRole("button", { name: "Cash", exact: true }).click()

    await expect(
      page.getByText("Open a cash session before taking cash.")
    ).toBeVisible()
    await expect(primary(page, "Mark sold")).toBeDisabled()
  })
})
