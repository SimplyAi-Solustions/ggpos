import { expect, test, type Page } from "@playwright/test"

import { buildCode } from "../packages/shared/src/sku"

/**
 * The till (`/counter/till`), driven against the demo fixtures at both of
 * the widths the suite runs: 1440 (two panes side by side) and 390 (two
 * tabs with the total and Pay docked). The demo till starts open.
 *
 * Every test signs in and then loads the till by its address. The ticket
 * lives in sessionStorage, so it survives that; the demo stock and sales
 * live in memory, so each test starts from the same shop morning.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

/** The demo Charizard at £324.99, Mabel at £12.49, and two customers. */
const CHARIZARD = buildCode("single", "7F3K2")
const MABEL = buildCode("single", "T4M9P")
const JASMINE = "GGC-4K7M2S"
const TOM = buildCode("customer", "9QB3X")

async function openTill(page: Page) {
  await page.goto("/login?demo=1")
  await page.getByLabel("Email").fill(DEMO_EMAIL)
  await page.getByLabel("Password").fill(DEMO_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()
  await page.goto("/counter/till")
  await expect(page.getByTestId("till")).toBeVisible()
  await expect(page.getByTestId("till-register")).toContainText("Open")
}

/** Below 900px the panes are tabs; these put the right one in front. */
async function showItems(page: Page) {
  const tab = page.getByRole("tab", { name: /^(Items|Pay|Done)$/ })
  if (await tab.isVisible()) await tab.click()
}

async function showTicket(page: Page) {
  const tab = page.getByTestId("till-ticket-tab")
  if (await tab.isVisible()) await tab.click()
}

async function scan(page: Page, code: string) {
  await showItems(page)
  const field = page.getByTestId("till-scan-field")
  await field.fill(code)
  await field.press("Enter")
}

async function tile(page: Page, name: string) {
  await showItems(page)
  await page.getByTestId("till-tile").filter({ hasText: name }).first().click()
}

function lines(page: Page) {
  return page.getByTestId("ticket-line")
}

async function pay(page: Page) {
  await page.getByTestId("till-pay").filter({ visible: true }).click()
  await expect(page.getByTestId("till-to-pay")).toBeVisible()
}

async function tender(page: Page, name: string) {
  await showItems(page)
  await page.getByRole("button", { name, exact: true }).click()
}

test.describe("the till", () => {
  test("rings up a cash sale with change, then starts the next one", async ({ page }) => {
    await openTill(page)
    await showTicket(page)
    await expect(page.getByTestId("ticket-empty")).toHaveText("Scan an item or tap a tile")

    await scan(page, CHARIZARD.display)
    await expect(page.getByText("Charizard ex added")).toBeVisible()
    await showTicket(page)
    await expect(lines(page)).toHaveCount(1)
    await expect(lines(page).first()).toContainText("Charizard ex")

    await pay(page)
    await expect(page.getByTestId("till-to-pay")).toHaveText("£324.99")

    await tender(page, "Cash")
    // £400.00 keyed on the money pad, which takes the keyboard too.
    await page.keyboard.type("40000")
    await expect(page.getByTestId("till-cash-amount")).toHaveText("£400.00")
    await page.getByTestId("till-take-cash").click()

    const done = page.getByTestId("till-done")
    await expect(done).toBeVisible()
    await expect(page.getByTestId("till-change")).toHaveText("£75.01")
    await expect(done).toContainText(/GG-S-\d{6}/)

    // No receipt starts the next sale on an empty ticket.
    await done.getByRole("button", { name: "No receipt" }).click()
    await expect(page.getByTestId("till-done")).toHaveCount(0)
    await showTicket(page)
    await expect(page.getByTestId("ticket-empty")).toBeVisible()

    // And the card it sold is no longer on the shelf.
    await scan(page, CHARIZARD.display)
    await expect(page.getByText("Charizard ex is no longer for sale.")).toBeVisible()
  })

  test("splits a sale between a cash note and the Tide card", async ({ page }) => {
    await openTill(page)
    await scan(page, MABEL.display)
    await tile(page, "Table time")
    await pay(page)
    await expect(page.getByTestId("till-to-pay")).toHaveText("£17.49")

    await tender(page, "Cash")
    await page.keyboard.type("1000")
    await page.getByTestId("till-take-cash").click()
    await expect(page.getByTestId("till-to-pay")).toHaveText("£7.49")
    await expect(page.getByTestId("till-tender")).toContainText("Cash")

    await tender(page, "Card")
    await expect(page.getByTestId("till-card-step")).toContainText("Key £7.49 on the Tide reader.")
    await page.getByTestId("till-card-approved").click()
    await expect(page.getByText("Key the last four digits of the card.")).toBeVisible()
    await page.getByLabel("Last four digits").fill("4242")
    await page.getByTestId("till-card-approved").click()

    // Nothing left to pay, so it completes on its own; no change, so the
    // sale number is the outcome.
    await expect(page.getByTestId("till-done")).toBeVisible()
    await expect(page.getByTestId("till-sale-number")).toHaveText(/GG-S-\d{6}/)
  })

  test("takes a quick cash note and a declined card in its stride", async ({ page }) => {
    await openTill(page)
    await scan(page, MABEL.display)
    await pay(page)

    await tender(page, "Card")
    await page.getByRole("button", { name: "Declined" }).click()
    await expect(
      page.getByText("Declined on the reader. Try the card again, or take it another way.")
    ).toBeVisible()

    await tender(page, "Cash")
    await page.getByRole("button", { name: "£20.00 handed over" }).click()
    await expect(page.getByTestId("till-change")).toHaveText("£7.51")
  })

  test("keys a price for an open-price tile and sells a membership to somebody", async ({
    page,
  }) => {
    await openTill(page)
    await tile(page, "Single card")
    const sheet = page.getByTestId("key-price-sheet")
    await expect(sheet).toBeVisible()
    await sheet.getByTestId("key-price-add").click()
    await expect(sheet.getByText("Key a price for Single card.")).toBeVisible()
    await page.keyboard.type("250")
    await sheet.getByLabel("What it is").fill("Pikachu")
    await sheet.getByTestId("key-price-add").click()
    await expect(sheet).toBeHidden()

    // A membership is sold to somebody, so the till asks who first.
    await tile(page, "Guild Membership")
    const customers = page.getByRole("dialog").filter({ hasText: "Attach customer" })
    await expect(customers).toBeVisible()
    await customers.getByLabel("Search customers").fill("Jasmine")
    await customers.getByRole("button", { name: /Jasmine Okafor/ }).click()

    await showTicket(page)
    await expect(page.getByTestId("ticket-customer")).toContainText("Jasmine Okafor")
    await expect(lines(page)).toHaveCount(2)
    await expect(lines(page).nth(0)).toContainText("Single card: Pikachu")
    await expect(lines(page).nth(1)).toContainText("Guild Membership, 12 months")
    // On the tablet and the Mac the total is in the ticket; on a phone it
    // is docked under both tabs.
    await expect(
      page.getByTestId("ticket-total").or(page.getByTestId("till-dock-total"))
    ).toHaveText("£26.50")
  })

  test("changes a line, discounts it and takes another off", async ({ page }) => {
    await openTill(page)
    await scan(page, CHARIZARD.display)
    await scan(page, MABEL.display)
    await showTicket(page)

    await page.getByRole("button", { name: "Change Charizard ex" }).click()
    const sheet = page.getByTestId("line-sheet")
    await expect(sheet).toBeVisible()
    await sheet.getByRole("button", { name: "Percent" }).click()
    await sheet.getByLabel("Percent off").fill("10")
    await sheet.getByLabel("Note").fill("Corner ding")
    await sheet.getByTestId("line-sheet-save").click()
    await expect(sheet).toBeHidden()

    const charizard = lines(page).filter({ hasText: "Charizard ex" })
    await expect(charizard).toContainText("Corner ding")
    await expect(charizard.getByTestId("ticket-line-total")).toHaveText("£292.49")

    await page.getByRole("button", { name: "Change Mabel, Heir to Cragflame" }).click()
    await sheet.getByRole("button", { name: "Remove from the ticket" }).click()
    await expect(lines(page)).toHaveCount(1)
  })

  test("parks a ticket and recalls it, warning about an item on both", async ({ page }) => {
    await openTill(page)
    await scan(page, JASMINE)
    await scan(page, CHARIZARD.display)
    await showTicket(page)
    await page.getByRole("button", { name: "Park", exact: true }).click()
    const park = page.getByRole("dialog").filter({ hasText: "Park ticket" })
    // The customer's first name is the label until somebody changes it.
    await expect(park.getByLabel("Name")).toHaveValue("Jasmine")
    await park.getByTestId("park-sheet-park").click()
    await expect(park).toBeHidden()
    await expect(page.getByTestId("till-parked")).toContainText("1")
    await expect(page.getByTestId("ticket-empty")).toBeVisible()

    // The same card on a new ticket: the till says it is on a parked one.
    await scan(page, CHARIZARD.display)
    await showTicket(page)
    await expect(
      page.getByText("Charizard ex is also on the parked ticket Jasmine.")
    ).toBeVisible()
    await page.getByRole("button", { name: "Clear ticket" }).click()
    await page.getByTestId("till-clear-confirm").click()
    await expect(page.getByTestId("ticket-empty")).toBeVisible()

    await page.getByTestId("till-parked").click()
    const recall = page.getByTestId("recall-sheet")
    await recall.getByTestId("parked-ticket").filter({ hasText: "Jasmine" }).click()
    await expect(recall).toBeHidden()
    await expect(page.getByTestId("ticket-customer")).toContainText("Jasmine Okafor")
    await expect(lines(page)).toHaveCount(1)
    await expect(page.getByTestId("till-parked")).toContainText("0")
  })

  test("keeps the ticket through a reload", async ({ page }) => {
    await openTill(page)
    await scan(page, MABEL.display)
    await tile(page, "Table time")
    await page.reload()
    await expect(page.getByTestId("till")).toBeVisible()
    await showTicket(page)
    await expect(lines(page)).toHaveCount(2)
  })

  test("takes a return from a scanned receipt, back to cash", async ({ page }) => {
    await openTill(page)
    // The demo morning's cash sale of Llanowar Elves, scanned off its
    // receipt barcode.
    await scan(page, "GGS000456")
    const sheet = page.getByTestId("returns-sheet")
    await expect(sheet).toBeVisible()
    await expect(sheet.getByTestId("returns-sale-number")).toHaveText("GG-S-000456")
    await expect(sheet.getByTestId("returns-lines")).toContainText("Llanowar Elves")

    await sheet.getByLabel("Reason").fill("Wrong card")
    // It was a cash sale, so the money goes back as cash unless changed.
    await expect(sheet.getByRole("button", { name: "Cash", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    await sheet.getByTestId("returns-refund").click()
    await expect(sheet.getByTestId("returns-done")).toContainText("£2.49")
    await expect(sheet.getByTestId("returns-done")).toContainText("GG-S-000456-R1")
  })

  test("prints the receipt, or says in one line why not, and never blocks the next sale", async ({
    page,
  }) => {
    await openTill(page)
    await scan(page, MABEL.display)
    await pay(page)
    await tender(page, "Cash")
    await page.getByRole("button", { name: "Exact" }).click()
    const done = page.getByTestId("till-done")
    await done.getByRole("button", { name: "Print", exact: true }).click()
    // Whichever the printer said: sent, or a sentence under the choices.
    await expect(
      page.getByText(/sent to the printer\.|not set up|printing in the browser/i).first()
    ).toBeVisible()
    if (await done.isVisible()) await page.getByTestId("till-new-sale").click()
    await expect(page.getByTestId("till-done")).toHaveCount(0)
  })

  test("asks for an address when the customer has no email on file", async ({ page }) => {
    await openTill(page)
    await scan(page, TOM.display)
    await expect(page.getByText(/attached/)).toBeVisible()
    await scan(page, MABEL.display)
    await pay(page)
    await tender(page, "Cash")
    await page.getByRole("button", { name: "Exact" }).click()

    const done = page.getByTestId("till-done")
    await done.getByRole("button", { name: "Email", exact: true }).click()
    await expect(
      done.getByText("There is no email address for this sale. Type one in.")
    ).toBeVisible()
    await done.getByLabel("Email the receipt to").fill("tom@example.co.uk")
    await done.getByRole("button", { name: "Send receipt" }).click()
    await expect(page.getByText(/sent to t\*\*\*@example\.co\.uk/)).toBeVisible()
  })

  test("sends an old Sell address to the till, keeping it full-bleed", async ({ page }) => {
    await openTill(page)
    await page.goto("/counter/sell")
    await expect(page).toHaveURL(/\/counter\/till$/)
    await expect(page.getByTestId("till")).toBeVisible()
    // The counter's own header and nav are not drawn around the till.
    await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0)
  })
})
