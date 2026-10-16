import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"

import { buildCode } from "../packages/shared/src/sku"

/**
 * Part-exchange and exchanges on the till (docs/api-contract-epos.md,
 * section 7), driven against the demo shop at both of the suite's widths:
 * 1440 (the ticket beside the catalogue) and 390 (two tabs, Pay docked).
 *
 * The demo sale answers `trade_in`, `trade_settlement` and `returns` with
 * the contract's arithmetic: A = min(V, S) goes on the sale as the
 * part-exchange, the surplus V - A is paid as credit or cash, and a return
 * is refunded off its own sale with min(R, S) set against the new one.
 *
 * The one trade line throughout is a sealed box at a £40.00 market, which
 * the seeded sealed band (70 percent credit, 55 percent cash) values at
 * £28.00 in part-exchange and £22.00 in cash.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

const ID_PHOTO = join(__dirname, "fixtures", "id-sample.png")

/** The demo Charizard at £324.99, Mabel at £12.49, and two customers. */
const CHARIZARD = buildCode("single", "7F3K2")
const MABEL = buildCode("single", "T4M9P")
const JASMINE = buildCode("customer", "4K7M2")
const TOM = buildCode("customer", "9QB3X")

const BOX = "Surging Sparks Elite Trainer Box"

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
async function showLeft(page: Page) {
  await expect(page.getByTestId("till")).toBeVisible()
  const tab = page.getByRole("tab", { name: /^(Items|Trade-in|Pay|Settle|Refund|Exchange|Done)$/ })
  if (await tab.isVisible()) await tab.click()
}

async function showTicket(page: Page) {
  await expect(page.getByTestId("till")).toBeVisible()
  const tab = page.getByTestId("till-ticket-tab")
  if (await tab.isVisible()) await tab.click()
}

async function scan(page: Page, code: string) {
  await showLeft(page)
  const field = page.getByTestId("till-scan-field")
  await field.fill(code)
  await field.press("Enter")
}

/** Drags a short stroke across the pad, which is what "signed" means here. */
async function sign(page: Page) {
  const pad = page.getByTestId("signature-pad")
  await pad.evaluate((el) => el.scrollIntoView({ block: "center" }))
  await page.waitForTimeout(200)
  const box = await pad.boundingBox()
  if (!box) throw new Error("The signature pad has no box to sign on")
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + 20, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.35, y - box.height * 0.2, { steps: 6 })
  await page.mouse.move(box.x + box.width * 0.6, y + box.height * 0.15, { steps: 6 })
  await page.mouse.up()
  await expect(page.getByText("Signature captured")).toBeVisible()
}

async function agree(page: Page) {
  await page
    .getByRole("switch", { name: "The customer has heard the terms and agrees to them" })
    .click()
  await sign(page)
}

/** Opens the Trade-in panel from the ticket and adds the sealed box at a £40.00 market. */
async function tradeTheBox(page: Page) {
  await showTicket(page)
  await page.getByTestId("till-trade-in").filter({ visible: true }).click()
  const panel = page.getByTestId("till-trade-panel")
  await expect(panel).toBeVisible()
  await panel.getByRole("button", { name: "Sealed", exact: true }).click()
  await panel.getByLabel("Title").fill(BOX)
  await panel.getByRole("button", { name: "Add line" }).click()
  await panel.getByLabel(`Market value for ${BOX}`).fill("40")
  // The line's own offer: credit, with the cash offer as the hint under it.
  await expect(panel.getByTestId("trade-line-credit")).toHaveText("£28.00")
  await expect(panel.getByTestId("trade-line-cash")).toContainText("£22.00")
  await expect(panel.getByTestId("till-trade-value")).toHaveText("£28.00")
}

function ticketTotal(page: Page) {
  return page.getByTestId("ticket-total").or(page.getByTestId("till-dock-total")).filter({ visible: true })
}

async function pressPay(page: Page) {
  await page.getByTestId("till-pay").filter({ visible: true }).click()
}

test.describe("part-exchange on the till", () => {
  test("takes a trade worth less than the sale and the rest by card", async ({ page }) => {
    await openTill(page)
    await scan(page, JASMINE.display)
    await expect(page.getByText("Jasmine Okafor attached")).toBeVisible()
    await scan(page, CHARIZARD.display)
    await expect(page.getByText("Charizard ex added")).toBeVisible()

    await tradeTheBox(page)

    // The trade is its own group on the ticket, and the Anton total is what
    // is left after it.
    await showTicket(page)
    const group = page.getByTestId("ticket-trade")
    await expect(group).toContainText("Trade-in")
    await expect(group.getByTestId("ticket-trade-line")).toContainText(BOX)
    await expect(group.getByTestId("ticket-trade-line")).toContainText("-£28.00")
    await expect(group.getByTestId("ticket-trade-total")).toHaveText("-£28.00")
    await expect(ticketTotal(page)).toHaveText("£296.99")

    await pressPay(page)
    await expect(page.getByTestId("till-to-pay")).toHaveText("£296.99")
    await expect(page.getByTestId("till-tender-applied")).toContainText("Part-exchange")
    await expect(page.getByTestId("till-tender-applied")).toContainText("£28.00")

    // The terms and the signature first: the trade step opens on its own.
    await expect(page.getByTestId("till-trade-step")).toContainText(
      "The trade-in pays £28.00 towards this sale."
    )
    await agree(page)

    await page.getByRole("button", { name: "Card", exact: true }).click()
    await expect(page.getByTestId("till-card-step")).toContainText("Key £296.99 on the Tide reader.")
    await page.getByLabel("Last four digits").fill("4242")
    await page.getByTestId("till-card-approved").click()

    const done = page.getByTestId("till-done")
    await expect(done).toBeVisible()
    await expect(page.getByTestId("till-done-trade")).toContainText(
      /Trade-in GG-BI-\d{6} paid £28\.00/
    )
    await expect(page.getByTestId("till-sale-number")).toHaveText(/GG-S-\d{6}/)
  })

  test("settles a trade worth more than the sale as store credit", async ({ page }) => {
    await openTill(page)
    await scan(page, JASMINE.display)
    await expect(page.getByText("Jasmine Okafor attached")).toBeVisible()
    await scan(page, MABEL.display)
    await expect(page.getByText(/Mabel, Heir to Cragflame added/)).toBeVisible()

    await tradeTheBox(page)
    await showTicket(page)
    await expect(ticketTotal(page)).toHaveText("£0.00")
    await expect(page.getByTestId("ticket-surplus")).toHaveText(
      "The trade-in is worth £15.51 more than the ticket."
    )
    await expect(page.getByTestId("till-pay").filter({ visible: true })).toHaveText("Settle")

    await pressPay(page)
    const settle = page.getByTestId("till-settle")
    await expect(settle).toBeVisible()
    await expect(page.getByTestId("till-settle-amount")).toHaveText("£15.51")

    // Nothing goes until the surplus has a home and the customer has signed.
    await page.getByTestId("till-settle-complete").click()
    await expect(settle.getByText("Pay the surplus as credit or cash.")).toBeVisible()
    await page.getByTestId("till-surplus-credit").click()
    await page.getByTestId("till-settle-complete").click()
    await expect(settle.getByText("Read the terms to the customer and tick the box.")).toBeVisible()
    await agree(page)
    await page.getByTestId("till-settle-complete").click()

    await expect(page.getByTestId("till-done")).toBeVisible()
    const trade = page.getByTestId("till-done-trade")
    await expect(trade).toContainText(/Trade-in GG-BI-\d{6} paid £12\.49/)
    await expect(trade).toContainText("Surplus £15.51 added as store credit")
  })

  test("pays the surplus in cash at the cash rate, through the ID step", async ({ page }) => {
    await openTill(page)
    // Tom has no ID on file, so cash needs the whole check.
    await scan(page, TOM.display)
    await expect(page.getByText("Tom Bradbury attached")).toBeVisible()
    await scan(page, MABEL.display)
    await expect(page.getByText(/Mabel, Heir to Cragflame added/)).toBeVisible()

    await tradeTheBox(page)
    await pressPay(page)
    await expect(page.getByTestId("till-settle")).toBeVisible()

    // £15.51 of credit is £12.19 at the cash rate (£22.00 of £28.00), and
    // staff can key it lower.
    await page.getByTestId("till-surplus-cash").click()
    await expect(page.getByTestId("till-settle-amount")).toHaveText("£12.19")
    await expect(page.getByTestId("till-surplus-difference")).toHaveText(
      "Paying £12.19 in cash instead of £15.51 in store credit. The £3.32 difference stays with the shop."
    )
    await page.keyboard.type("1000")
    await expect(page.getByTestId("till-surplus-cash-amount")).toHaveText("£10.00")
    await expect(page.getByTestId("till-surplus-difference")).toHaveText(
      "Paying £10.00 in cash instead of £15.51 in store credit. The £5.51 difference stays with the shop."
    )

    // The buy-in's own ID step, and its refusals.
    const id = page.getByTestId("till-id-step")
    await expect(id.getByText("Photo of the ID")).toBeVisible()
    await agree(page)
    await page.getByTestId("till-settle-complete").click()
    await expect(page.getByText("Photograph the ID before you continue.")).toBeVisible()

    await id.getByTestId("id-photo-input").setInputFiles(ID_PHOTO)
    await expect(id.getByTestId("id-photo-preview")).toBeVisible()
    await id.getByLabel("Expires").fill("2032-06-30")
    await id.getByLabel("Last four digits").fill("4471")
    await id.getByLabel("Date of birth").fill("1990-05-02")
    await id.getByLabel("Address").fill("4 Sherwood Lodge Drive, Chesterfield, S41 9AB")
    await id
      .getByRole("switch", { name: "I have seen the original document and it matches" })
      .click()
    await page.getByTestId("till-settle-complete").click()

    await expect(page.getByTestId("till-done")).toBeVisible()
    await expect(page.getByTestId("till-payout")).toHaveText("£10.00")
    const trade = page.getByTestId("till-done-trade")
    await expect(trade).toContainText(/Trade-in GG-BI-\d{6} paid £12\.49/)
    await expect(trade).toContainText("Surplus paid in cash, £10.00")
  })
})

test.describe("exchanges on the till", () => {
  test("exchanges a returned card for a new one and takes the difference", async ({ page }) => {
    await openTill(page)
    // The demo morning's cash sale of Llanowar Elves, off its receipt.
    await scan(page, "GGS000456")
    const sheet = page.getByTestId("returns-sheet")
    await expect(sheet.getByTestId("returns-sale-number")).toHaveText("GG-S-000456")
    await sheet.getByTestId("returns-exchange").click()
    await expect(sheet.getByText("Say why it is coming back.")).toBeVisible()
    await sheet.getByLabel("Reason").fill("Wrong card")
    await sheet.getByTestId("returns-exchange").click()
    await expect(sheet).toBeHidden()

    await scan(page, MABEL.display)
    await expect(page.getByText(/Mabel, Heir to Cragflame added/)).toBeVisible()

    await showTicket(page)
    const returned = page.getByTestId("ticket-returns")
    await expect(returned).toContainText("Returned")
    await expect(returned.getByTestId("ticket-return-line")).toContainText("Llanowar Elves")
    await expect(returned.getByTestId("ticket-return-line")).toContainText("-£2.49")
    await expect(returned.getByTestId("ticket-return-reason")).toHaveText("Wrong card")
    await expect(ticketTotal(page)).toHaveText("£10.00")

    await pressPay(page)
    await expect(page.getByTestId("till-to-pay")).toHaveText("£10.00")
    await expect(page.getByTestId("till-tender-applied")).toContainText("Exchange")
    await expect(page.getByTestId("till-tender-applied")).toContainText("£2.49")
    await page.getByRole("button", { name: "Cash", exact: true }).click()
    await page.getByRole("button", { name: "Exact" }).click()

    await expect(page.getByTestId("till-done")).toBeVisible()
    await expect(page.getByTestId("till-done-refund")).toContainText("Refund GG-S-000456-R1, £2.49")
    await expect(page.getByTestId("till-sale-number")).toHaveText(/GG-S-\d{6}/)
  })

  test("sets a trade-in and a return against one sale, the trade first", async ({ page }) => {
    await openTill(page)
    await scan(page, JASMINE.display)
    await expect(page.getByText("Jasmine Okafor attached")).toBeVisible()
    await scan(page, "GGS000456")
    const sheet = page.getByTestId("returns-sheet")
    await sheet.getByLabel("Reason").fill("Wrong card")
    await sheet.getByTestId("returns-exchange").click()
    await expect(sheet).toBeHidden()
    await scan(page, CHARIZARD.display)
    await expect(page.getByText("Charizard ex added")).toBeVisible()
    await tradeTheBox(page)

    // £324.99, less £28.00 of trade, less £2.49 coming back.
    await showTicket(page)
    await expect(ticketTotal(page)).toHaveText("£294.50")
    await pressPay(page)
    await expect(page.getByTestId("till-to-pay")).toHaveText("£294.50")
    const applied = page.getByTestId("till-tender-applied")
    await expect(applied).toHaveCount(2)
    await expect(applied.nth(0)).toContainText("Part-exchange")
    await expect(applied.nth(1)).toContainText("Exchange")
    await agree(page)

    await page.getByRole("button", { name: "Card", exact: true }).click()
    await page.getByLabel("Last four digits").fill("4242")
    await page.getByTestId("till-card-approved").click()

    await expect(page.getByTestId("till-done")).toBeVisible()
    await expect(page.getByTestId("till-done-trade")).toContainText(
      /Trade-in GG-BI-\d{6} paid £28\.00/
    )
    await expect(page.getByTestId("till-done-refund")).toContainText("Refund GG-S-000456-R1, £2.49")
  })

  test("refunds a ticket of returns alone back to the card", async ({ page }) => {
    await openTill(page)
    // The Elite Trainer Box sold this morning, paid on a card.
    await scan(page, "GGS000455")
    const sheet = page.getByTestId("returns-sheet")
    await expect(sheet.getByTestId("returns-sale-number")).toHaveText("GG-S-000455")
    await sheet.getByLabel("Reason").fill("Changed their mind")
    await sheet.getByTestId("returns-exchange").click()
    await expect(sheet).toBeHidden()

    await showTicket(page)
    await expect(page.getByTestId("ticket-surplus")).toHaveText(
      "Nothing new is on the ticket, so this is a refund of £47.45."
    )
    await expect(page.getByTestId("till-pay").filter({ visible: true })).toHaveText("Refund")
    await pressPay(page)

    const refund = page.getByTestId("till-refund")
    await expect(refund).toBeVisible()
    await expect(page.getByTestId("till-refund-amount")).toHaveText("£47.45")
    // It was paid on a card, so it goes back to the card unless changed.
    await expect(refund.getByRole("button", { name: "Card", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    await page.getByTestId("till-refund-complete").click()

    await expect(page.getByTestId("till-done")).toBeVisible()
    await expect(page.getByTestId("till-sale-number")).toHaveText("GG-S-000455-R1")
    await expect(page.getByTestId("till-done-refund")).toContainText(
      "Refund GG-S-000455-R1, £47.45"
    )
    await expect(page.getByTestId("till-done-refund")).toContainText("£47.45 back to the card")
  })
})
