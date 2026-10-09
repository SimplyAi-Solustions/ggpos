import { expect, test, type Page } from "@playwright/test"

/**
 * Bookings (docs/api-contract-launch.md, section 4), end to end against the
 * demo shop at both of the suite's widths: the counter's day view, the
 * stations, events, the till taking a booking's payment, and My Vault.
 *
 * The demo bookings live in memory for the page, so each test loads the
 * bookings screen once and then moves between the day view and the till by
 * the app's own links, never by reloading.
 */

const STAFF_EMAIL = "demo@ggentertainment.co.uk"
const STAFF_PASSWORD = "ggvault-demo"
const PORTAL_EMAIL = "jasmine.okafor@example.co.uk"
const PORTAL_CODE = "48213976"
/** Jasmine's Guild card QR, the portal link the card prints. */
const JASMINE_QR = "https://ggpos.ggentertainment.co.uk/c/demo-4k7m2-token"

// The built app's service worker answers navigations from its own cache;
// nothing here tests it.
test.use({ serviceWorkers: "block" })

async function signIn(page: Page) {
  await page.goto("/login?demo=1")
  await page.getByLabel("Email").fill(STAFF_EMAIL)
  await page.getByLabel("Password").fill(STAFF_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()
}

async function openBookings(page: Page) {
  await signIn(page)
  await page.goto("/counter/bookings")
  await expect(page.getByTestId("bookings")).toBeVisible()
}

/** The screen's one block button: in the flow on a desktop, docked on a phone. */
function primary(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true }).filter({ visible: true })
}

async function payExactCash(page: Page) {
  await expect(page.getByTestId("till")).toBeVisible()
  await page.getByTestId("till-pay").filter({ visible: true }).click()
  await expect(page.getByTestId("till-to-pay")).toBeVisible()
  const tab = page.getByRole("tab", { name: /^(Items|Pay|Done)$/ })
  if (await tab.isVisible()) await tab.click()
  await page.getByRole("button", { name: "Cash", exact: true }).click()
  await page.getByRole("button", { name: "Exact" }).click()
  await expect(page.getByTestId("till-done")).toBeVisible()
}

async function showTicket(page: Page) {
  const tab = page.getByTestId("till-ticket-tab")
  if (await tab.isVisible()) await tab.click()
}

/** Back to bookings by the counter's own navigation, so nothing reloads. */
async function backToBookings(page: Page) {
  const nav = page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Bookings" })
  if (await nav.isVisible()) {
    await nav.click()
  } else {
    await page.getByRole("button", { name: "More" }).click()
    await page.getByRole("button", { name: "Bookings", exact: true }).click()
  }
  await expect(page.getByTestId("bookings")).toBeVisible()
}

test.describe("bookings at the counter", () => {
  test("books a table, refuses a clash, moves it, checks it in and takes payment at the till", async ({
    page,
  }) => {
    await openBookings(page)
    await page.getByRole("button", { name: "Tables", exact: true }).click()

    // ---- Book Table 3 at three ----
    await page.getByRole("button", { name: "Book Table 3 at 15:00" }).click()
    const book = page.getByTestId("book-sheet")
    await expect(book).toBeVisible()
    await book.getByLabel("Name", { exact: true }).fill("Lee Harris")
    await book.getByRole("button", { name: "Book Table 3" }).click()
    await expect(book).toBeHidden()
    await expect(page.getByTestId("bookings-notice")).toHaveText(
      "Table 3 booked for Lee Harris, today, 15:00 to 16:00."
    )
    const block = page.getByTestId("day-block").filter({ hasText: "Lee Harris" })
    await expect(block).toBeVisible()

    // ---- A second try over it is refused in the contract's words ----
    await page.getByRole("button", { name: "Book Table 3 at 14:00" }).click()
    await expect(book).toBeVisible()
    await book.getByRole("button", { name: "2 hours" }).click()
    await book.getByLabel("Name", { exact: true }).fill("Second try")
    await book.getByRole("button", { name: "Book Table 3" }).click()
    await expect(book.getByTestId("book-problem")).toHaveText(
      "Table 3 is booked from 15:00 to 16:00. Pick another time or another table."
    )
    await page.keyboard.press("Escape")
    await expect(book).toBeHidden()

    // ---- Move it an hour later, from its sheet ----
    await block.click()
    const sheet = page.getByTestId("booking-sheet")
    await expect(sheet).toBeVisible()
    await sheet.getByRole("button", { name: "Move", exact: true }).click()
    await sheet.getByRole("combobox", { name: "Starts" }).click()
    await page.getByRole("option", { name: "16:00", exact: true }).click()
    await sheet.getByRole("button", { name: "Move booking" }).click()
    await expect(page.getByTestId("bookings-notice")).toContainText("Lee Harris moved to")
    await expect(page.getByTestId("bookings-notice")).toContainText("16:00 to 17:00")

    // ---- Check in, then take payment at the till ----
    await sheet.getByRole("button", { name: "Check in" }).click()
    await expect(sheet.getByTestId("booking-state")).toHaveText("Checked in")
    await sheet.getByRole("button", { name: "Take payment" }).click()
    await sheet.getByTestId("pay-full").click()

    await expect(page.getByTestId("till")).toBeVisible()
    await showTicket(page)
    await expect(page.getByTestId("ticket-line")).toHaveCount(1)
    await expect(page.getByTestId("ticket-line").first()).toContainText("Table 3")
    await expect(page.getByTestId("ticket-line").first()).toContainText("Booking")
    await payExactCash(page)
    await page.getByTestId("till-done").getByRole("button", { name: "No receipt" }).click()

    // ---- The booking now says it is paid ----
    await page.getByRole("link", { name: "Back to the counter" }).click()
    await backToBookings(page)
    await page.getByRole("button", { name: "Tables", exact: true }).click()
    await page.getByTestId("day-block").filter({ hasText: "Lee Harris" }).click()
    await expect(page.getByTestId("booking-paid")).toHaveText("Paid")
  })

  test("starts and stops a PC session and pays it at the till", async ({ page }) => {
    await openBookings(page)
    const station = page.getByTestId("station").filter({ hasText: "PC 2" })
    await expect(station).toHaveAttribute("data-state", "free")
    await page.getByRole("button", { name: "Start PC 2" }).click()
    const start = page.getByTestId("start-sheet")
    await expect(start).toBeVisible()
    await start.getByRole("button", { name: "Start the clock" }).click()
    await expect(start).toBeHidden()
    await expect(page.getByTestId("bookings-notice")).toHaveText("PC 2 is on the clock for Walk-in.")
    await expect(station).toHaveAttribute("data-state", "in-use")
    await expect(station.getByTestId("station-charge")).toContainText("£4.00")

    await page.getByRole("button", { name: "Stop PC 2" }).click()
    const stop = page.getByTestId("stop-sheet")
    await expect(stop).toContainText("£4.00")
    await stop.getByRole("button", { name: "Stop and take payment" }).click()

    await expect(page.getByTestId("till")).toBeVisible()
    await showTicket(page)
    await expect(page.getByTestId("ticket-line").first()).toContainText("PC 2")
    await expect(page.getByTestId("ticket-line").first()).toContainText("session")
    await payExactCash(page)
    await expect(page.getByTestId("till-done")).toContainText(/GG-S-\d{6}/)
  })

  test("takes a booking's deposit from the till's own Bookings sheet", async ({ page }) => {
    await signIn(page)
    await page.goto("/counter/till")
    await expect(page.getByTestId("till")).toBeVisible()
    await page.getByRole("button", { name: "Till menu" }).click()
    await page.getByRole("menuitem", { name: "Bookings" }).click()
    const sheet = page.getByTestId("till-bookings-sheet")
    await expect(sheet).toBeVisible()
    const ellis = sheet.getByTestId("till-booking").filter({ hasText: "Ellis, 9th birthday" })
    await ellis.getByRole("button", { name: /^Deposit £20\.00/ }).click()
    await expect(sheet).toBeHidden()
    await showTicket(page)
    await expect(page.getByTestId("ticket-line").first()).toContainText("Party room")
    await expect(page.getByTestId("ticket-line").first()).toContainText("deposit")
  })

  test("creates an event, enters a customer at the Guild fee and checks them in by their card", async ({
    page,
  }) => {
    await openBookings(page)
    await page.getByRole("tab", { name: "Events" }).click()
    await primary(page, "New event").click()

    // Today, all day: BK checks an entry in on the event's own day only, and
    // the suite may run at any hour.
    const form = page.getByTestId("new-event-sheet")
    await expect(form).toBeVisible()
    await form.getByLabel("Name", { exact: true }).fill("Lorcana draft")
    await form.getByLabel("Starts", { exact: true }).fill("00:00")
    await form.getByLabel("Ends", { exact: true }).fill("23:45")
    await form.getByLabel("Places", { exact: true }).fill("8")
    await form.getByLabel("Entry fee").fill("6.00")
    await form.getByLabel("Guild fee").fill("5.00")
    await form.getByRole("button", { name: "Publish event" }).click()
    await expect(form).toBeHidden()
    await expect(page.getByTestId("bookings-notice")).toContainText("Lorcana draft is published for")

    await page.getByTestId("event-row").filter({ hasText: "Lorcana draft" }).click()
    const sheet = page.getByTestId("event-sheet")
    await expect(sheet).toBeVisible()
    await expect(sheet.getByTestId("event-places")).toHaveText("8 of 8 places left. £6.00, Guild £5.00.")

    await sheet.getByRole("searchbox", { name: /Customer/ }).fill("Jasmine")
    await sheet.getByRole("button", { name: /Jasmine Okafor/ }).click()
    await expect(sheet.getByTestId("entry-fee")).toHaveText("£5.00")
    await sheet.getByRole("button", { name: "Enter Jasmine Okafor" }).click()
    await expect(sheet.getByTestId("event-notice")).toHaveText("Jasmine Okafor is entered in Lorcana draft.")
    const entry = sheet.getByTestId("event-entry").filter({ hasText: "Jasmine Okafor" })
    await expect(entry).toContainText("£5.00 to pay")
    await expect(sheet.getByTestId("event-places")).toHaveText("7 of 8 places left. £6.00, Guild £5.00.")

    // Her Guild card's QR, read into the check-in field.
    const field = sheet.getByTestId("event-checkin-field")
    await field.fill(JASMINE_QR)
    await field.press("Enter")
    await expect(sheet.getByTestId("event-notice")).toHaveText("Jasmine Okafor checked in.")
    await expect(entry).toContainText("checked in")
  })
})

test.describe("booking in My Vault", () => {
  test("books a table as a Guild member at the Guild price, to pay at the till", async ({ page }) => {
    await page.goto("/account?demo=1")
    await page.getByLabel("Email").fill(PORTAL_EMAIL)
    await page.getByRole("button", { name: "Send me a code" }).click()
    await page.getByLabel("Code", { exact: true }).fill(PORTAL_CODE)
    await page.getByRole("button", { name: "Sign in" }).click()
    await expect(page.getByRole("heading", { name: "My card" })).toBeVisible()

    await page.getByRole("link", { name: "Book", exact: true }).filter({ visible: true }).click()
    await expect(page.getByTestId("portal-book-screen")).toBeVisible()
    await page.getByRole("button", { name: "Tomorrow", exact: true }).click()
    const table = page.getByTestId("portal-resource").filter({ hasText: "Table 1" })
    await expect(table).toContainText("£4.00 an hour")
    await expect(table).toContainText("The Guild price. £5.00 an hour for anybody else.")
    await table.getByTestId("portal-slot").first().click()

    const choice = page.getByTestId("portal-choice")
    await expect(choice.getByTestId("portal-price")).toHaveText("£4.00")
    await expect(choice).toContainText("The Guild price, £5.00 for anybody else.")
    await expect(choice).toContainText("Paid at the till when you arrive.")
    await page.getByTestId("portal-book").filter({ visible: true }).click()

    await expect(page.getByTestId("portal-book-done")).toContainText("Table 1 is held for you on")
    await expect(page.getByTestId("portal-book-done")).toContainText("Pay £4.00 at the till when you arrive.")
    await expect(page).toHaveURL(/\/account\/bookings/)
    const mine = page.getByTestId("portal-my-booking").filter({ hasText: "Table 1" })
    await expect(mine).toContainText("£4.00 to pay at the till")
    await expect(mine).toContainText("held")
  })
})
