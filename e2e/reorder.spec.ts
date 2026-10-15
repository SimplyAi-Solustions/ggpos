import { expect, test, type Page } from "@playwright/test"

/**
 * The supplier call (docs/api-contract-reorder.md, section 4.5), driven
 * against the demo's Games Workshop rack at both widths.
 *
 * The rack's figures are worked by hand in
 * `apps/web/src/lib/api/demo/supplier-stock.ts`: over the last seven days,
 * 20 units in stock, 25 sold, 3 products out, 24 units to order across
 * seven products, and three open requests. The demo lives in the tab, so
 * every step here moves between screens through the app (the palette, a
 * link, the browser's back) and never reloads the page.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

/** The To order list, most to order first, as Copy order writes it. */
const ORDER = [
  "29-38, Citadel Contrast: Black Templar, 6",
  "24-14, Citadel Shade: Nuln Oil, 5",
  "21-25, Citadel Base: Abaddon Black, 4",
  "49-41, Combat Patrol: Necrons, 3",
  "48-75, Combat Patrol: Space Marines, 3",
  "63-05, Citadel Large Base Brush, 2",
  "70-19, Spearhead: Stormcast Eternals, 1",
]

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
  const palette = page.getByRole("dialog")
  await expect(palette).toBeVisible()
  await palette.getByText(action, { exact: true }).click()
  await expect(palette).toBeHidden()
}

/** Below 900px an action can be a second, docked copy of the same button. */
function visible(page: Page, role: "button" | "link", name: string) {
  return page.getByRole(role, { name, exact: true }).filter({ visible: true })
}

async function openCall(page: Page) {
  await go(page, "Supplier call: Games Workshop")
  await expect(page.getByRole("heading", { level: 1, name: "Games Workshop" })).toBeVisible()
  await expect(page.getByTestId("reorder-toOrder")).toBeVisible()
}

/** The products on the rack, top to bottom. */
function rackTitles(page: Page) {
  return page
    .getByTestId("rack-row")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-product") ?? ""))
}

function rackRow(page: Page, title: string) {
  return page.locator(`[data-testid="rack-row"][data-product="${title}"]`)
}

async function showEverything(page: Page) {
  await page.getByRole("button", { name: "Everything", exact: true }).click()
  await expect(page).toHaveURL(/view=all/)
  await expect(page.getByTestId("rack-row")).toHaveCount(12)
}

test.describe("supplier calls", () => {
  test("Reports opens the Games Workshop call with the week's figures and the To order list", async ({ page }) => {
    await signIn(page)
    await go(page, "Reports")
    const calls = page.getByTestId("supplier-call-list").getByRole("link")
    await expect(calls.first()).toContainText("Games Workshop")
    await expect(calls.first()).toContainText("Stock, sales, orders and requests for the weekly call.")
    await calls.first().click()

    await expect(page).toHaveURL(/\/counter\/reports\/reorder\?supplier=/)
    await expect(page.getByRole("heading", { level: 1, name: "Games Workshop" })).toBeVisible()
    // One Anton line: the supplier's name.
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1)
    await expect(page.getByText("The weekly call: what sold, what is out, what to order and what customers asked for.")).toBeVisible()
    await expect(page.getByTestId("reorder-rep")).toHaveText(
      "Rep: Dan, 07700 900321, dan@example.co.uk. Account GW-48213"
    )
    await expect(page.getByRole("button", { name: "Last 7 days" })).toHaveAttribute("aria-pressed", "true")

    await expect(page.getByTestId("reorder-inStock")).toHaveText("20")
    await expect(page.getByTestId("reorder-sold")).toHaveText("25")
    await expect(page.getByTestId("reorder-outOfStock")).toHaveText("3")
    await expect(page.getByTestId("reorder-toOrder")).toHaveText("24")
    await expect(page.getByTestId("reorder-openRequests")).toHaveText("3")

    // To order is the chip it opens on: most to order first.
    await expect(page.getByRole("button", { name: "To order", exact: true })).toHaveAttribute("aria-pressed", "true")
    expect(await rackTitles(page)).toEqual(ORDER.map((line) => line.split(", ").slice(1, -1).join(", ")))
    const necrons = rackRow(page, "Combat Patrol: Necrons")
    await expect(necrons.getByTestId("rack-to-order")).toContainText("3")
    await expect(necrons.getByTestId("rack-status")).toHaveText("Out of stock")
    await expect(necrons).toContainText("49-41")
    await expect(rackRow(page, "Citadel Shade: Nuln Oil").getByTestId("rack-status")).toHaveText("Below target")

    // Out of stock: the three with none on hand.
    await page.getByRole("button", { name: "Out of stock", exact: true }).click()
    expect(await rackTitles(page)).toEqual([
      "Citadel Contrast: Black Templar",
      "Combat Patrol: Necrons",
      "Citadel Large Base Brush",
    ])
  })

  test("a target set in Everything saves and moves the line", async ({ page }) => {
    await signIn(page)
    await openCall(page)
    await showEverything(page)

    let titles = await rackTitles(page)
    expect(titles.indexOf("Kill Team: Starter Set")).toBe(10)
    await expect(rackRow(page, "Kill Team: Starter Set").getByTestId("rack-status")).toHaveText("No target")

    const field = page.getByLabel("Keep on shelf for Kill Team: Starter Set")
    await field.fill("3")
    await field.press("Enter")

    await expect(page.getByTestId("rack-note")).toHaveText("Keep on shelf for Kill Team: Starter Set is 3 now.")
    await expect(page.getByTestId("reorder-toOrder")).toHaveText("26")
    // One on hand against a target of three: two to order, after the brush
    // that is out with the same two to order.
    await expect.poll(async () => (await rackTitles(page)).indexOf("Kill Team: Starter Set")).toBe(6)
    titles = await rackTitles(page)
    expect(titles[5]).toBe("Citadel Large Base Brush")
    await expect(rackRow(page, "Kill Team: Starter Set").getByTestId("rack-status")).toHaveText("Below target")
    await expect(page.getByLabel("Keep on shelf for Kill Team: Starter Set")).toHaveValue("3")

    // Something that is not a whole number is refused and nothing moves.
    const brush = page.getByLabel("Keep on shelf for Citadel Large Base Brush")
    await brush.fill("two")
    await brush.press("Enter")
    await expect(page.getByTestId("rack-note")).toContainText("Keep on shelf is a whole number, 0 or more.")
    await expect(page.getByTestId("reorder-toOrder")).toHaveText("26")

    // And it is on the To order chip now.
    await page.getByRole("button", { name: "To order", exact: true }).click()
    expect(await rackTitles(page)).toContain("Kill Team: Starter Set")
  })

  test("a request with a contact name is added and moved to Asked the rep", async ({ page }) => {
    await signIn(page)
    await openCall(page)

    await page.getByRole("button", { name: "Add a request" }).click()
    const sheet = page.getByTestId("request-sheet")
    await expect(sheet).toBeVisible()
    await expect(sheet).toContainText("For Games Workshop.")

    // Nothing filled in: each problem in the hook's words.
    await sheet.getByRole("button", { name: "Add request" }).click()
    await expect(sheet).toContainText("Say what the customer is after.")
    await expect(sheet).toContainText("Add the customer, or a name to contact, so they can be told when it comes in.")

    await sheet.getByLabel("What are they after").fill("Kill Team: Hivestorm terrain")
    await sheet.getByRole("button", { name: "One more" }).click()
    await expect(sheet.getByLabel("Quantity")).toHaveValue("2")
    await sheet.getByLabel("Or a name to contact").fill("Ellie Shaw")
    await sheet.getByLabel("Phone").fill("07700 900111")
    await sheet.getByLabel("Notes").fill("Ring after four.")
    await sheet.getByRole("button", { name: "Add request" }).click()
    await expect(sheet).toBeHidden()

    await expect(page.getByTestId("requests-note")).toHaveText(
      "Kill Team: Hivestorm terrain is on the list, waiting to be asked for."
    )
    await expect(page.getByTestId("reorder-openRequests")).toHaveText("4")
    const row = page.locator('[data-testid="request-row"][data-request="Kill Team: Hivestorm terrain"]')
    await expect(row).toContainText("Ellie Shaw")
    await expect(row).toContainText("07700 900111")
    await expect(row).toContainText("Quantity 2.")
    await expect(row).toContainText("by Demo Counter")
    await expect(row).toContainText("Ring after four.")
    // Newest last: the requests are in the order they were asked.
    await expect(page.getByTestId("request-row").last()).toHaveAttribute("data-request", "Kill Team: Hivestorm terrain")

    const status = page.getByRole("combobox", { name: "Status of Kill Team: Hivestorm terrain" })
    await expect(status).toContainText("Waiting")
    await status.click()
    await page.getByRole("option", { name: "Asked the rep" }).click()
    await expect(status).toContainText("Asked the rep")
    await expect(page.getByTestId("requests-note")).toHaveText("Moved Kill Team: Hivestorm terrain to Asked the rep.")

    // Collected leaves the open list.
    await status.click()
    await page.getByRole("option", { name: "Collected" }).click()
    await expect(page.getByTestId("requests-note")).toHaveText(
      "Moved Kill Team: Hivestorm terrain to Collected. It leaves the open requests."
    )
    await expect(row).toHaveCount(0)
    await expect(page.getByTestId("reorder-openRequests")).toHaveText("3")
  })

  test("Copy order puts the To order lines on the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    await signIn(page)
    await openCall(page)

    await page.getByRole("button", { name: "Copy order" }).click()
    await expect(page.getByTestId("reorder-action-note")).toHaveText("Order copied: 7 products, 24 units.")
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(ORDER.join("\n"))
  })

  test("the item page's supplier fields save and reach the call", async ({ page }) => {
    await signIn(page)
    await openCall(page)
    await visible(page, "link", "Combat Patrol: Space Marines").click()
    await expect(page.getByRole("heading", { level: 1, name: "Combat Patrol: Space Marines" })).toBeVisible()

    const supplier = page.getByRole("combobox", { name: "Supplier" })
    const target = page.getByRole("textbox", { name: "Keep on shelf" })
    const code = page.getByRole("textbox", { name: "Supplier code" })
    await expect(supplier).toContainText("Games Workshop")
    await expect(target).toHaveValue("4")
    await expect(code).toHaveValue("48-75")

    // Restocked once, so the product is two rows, and both take it.
    await target.fill("6")
    await target.press("Enter")
    await expect(page.getByText("Saved on both stock rows of this product", { exact: true })).toBeVisible()
    await expect(target).toHaveValue("6")
    await code.fill("48-75B")
    await code.press("Enter")
    await expect(code).toHaveValue("48-75B")

    // A target that is not a whole number is said under the field.
    await target.fill("-2")
    await target.press("Enter")
    await expect(page.getByRole("alert").filter({ hasText: "Keep on shelf is a whole number, 0 or more." })).toBeVisible()
    await target.fill("6")
    await target.press("Enter")

    // Back on the call: one on hand against six is five to order.
    await page.goBack()
    await expect(page.getByRole("heading", { level: 1, name: "Games Workshop" })).toBeVisible()
    const marines = rackRow(page, "Combat Patrol: Space Marines")
    await expect(marines.getByTestId("rack-to-order")).toContainText("5")
    await expect(marines).toContainText("48-75B")
    await expect(page.getByTestId("reorder-toOrder")).toHaveText("26")

    // Moved to another supplier, it leaves this call.
    await visible(page, "link", "Combat Patrol: Space Marines").click()
    await supplier.click()
    await page.getByRole("option", { name: "Asmodee UK" }).click()
    await expect(supplier).toContainText("Asmodee UK")
    await page.goBack()
    await expect(page.getByRole("heading", { level: 1, name: "Games Workshop" })).toBeVisible()
    await expect(rackRow(page, "Combat Patrol: Space Marines")).toHaveCount(0)
    await expect(page.getByTestId("reorder-toOrder")).toHaveText("21")
  })

  test("Add more of this fills Add stock from the item, and the call sees what came in", async ({ page }) => {
    await signIn(page)
    await openCall(page)
    await visible(page, "link", "Combat Patrol: Space Marines").click()
    await expect(page.getByRole("heading", { level: 1, name: "Combat Patrol: Space Marines" })).toBeVisible()
    await visible(page, "link", "Add more of this").click()

    await expect(page).toHaveURL(/\/counter\/stock\/new\?from=/)
    await expect(page.getByTestId("stock-from-note")).toHaveText(
      "Filled from Combat Patrol: Space Marines. Say how many came in."
    )
    await expect(page.getByTestId("stock-branch-path")).toHaveText("Miniatures and paints / Warhammer 40,000")
    await expect(page.getByRole("combobox", { name: "Game" })).toContainText("Warhammer")
    await expect(page.getByRole("combobox", { name: "Kind" })).toContainText("Other")
    await expect(page.getByRole("combobox", { name: "VAT" })).toContainText("Standard rate, 20%")
    await expect(page.getByLabel("Title")).toHaveValue("Combat Patrol: Space Marines")
    await expect(page.getByLabel("Cost")).toHaveValue("57.00")
    await expect(page.getByLabel("Price")).toHaveValue("95.00")
    await expect(page.getByRole("combobox", { name: "Location" })).toContainText("Storeroom")
    await expect(page.getByRole("combobox", { name: "Supplier", exact: true })).toContainText("Games Workshop")
    await expect(page.getByLabel("Keep on shelf")).toHaveValue("4")
    await expect(page.getByLabel("Supplier code")).toHaveValue("48-75")
    // The quantity waits to be counted.
    await expect(page.getByLabel("Quantity")).toHaveValue("")

    await visible(page, "button", "Save item").click()
    await expect(page.getByText("Quantity is at least 1.")).toBeVisible()
    await page.getByLabel("Quantity").fill("3")
    await visible(page, "button", "Save item").click()
    await expect(page.getByRole("heading", { name: "Saved" })).toBeVisible()

    // Three more on the shelf: four against a target of four.
    await openCall(page)
    await expect(page.getByTestId("reorder-inStock")).toHaveText("23")
    await expect(page.getByTestId("reorder-toOrder")).toHaveText("21")
    await expect(rackRow(page, "Combat Patrol: Space Marines")).toHaveCount(0)
  })

  test("a supplier with nothing on the shelf says what to do", async ({ page }) => {
    await signIn(page)
    await go(page, "Supplier call: Asmodee UK")
    await expect(page.getByRole("heading", { level: 1, name: "Asmodee UK" })).toBeVisible()
    await expect(page.getByTestId("rack-empty")).toHaveText(
      "No Asmodee UK stock yet. Set the supplier and Keep on shelf on an item to put it on this list."
    )
    await expect(page.getByTestId("requests-empty")).toContainText("No open requests.")
    await expect(page.getByRole("button", { name: "Copy order" })).toBeDisabled()
  })

  test("a custom period is checked before it is asked for, and an unknown supplier is said", async ({ page }) => {
    await signIn(page)
    await openCall(page)
    await page.getByRole("button", { name: "Custom", exact: true }).click()
    const to = await page.getByLabel("To", { exact: true }).inputValue()
    await page.getByLabel("From", { exact: true }).fill("2099-01-01")
    await expect(page.getByText("The from date is after the to date. Swap them over.")).toBeVisible()
    await page.getByLabel("From", { exact: true }).fill(to)
    await expect(page).toHaveURL(new RegExp(`from=${to}`))
    // One day: only what sold today, which is the two tubes of glue.
    await expect(page.getByTestId("reorder-sold")).toHaveText("2")
    await page.getByRole("button", { name: "Last 7 days" }).click()
    await expect(page.getByTestId("reorder-sold")).toHaveText("25")

    await page.goto("/counter/reports/reorder?supplier=nope")
    await expect(page.getByRole("heading", { level: 1, name: "Supplier call" })).toBeVisible()
    await expect(page.getByTestId("reorder-error")).toHaveText("That supplier was not found.")
  })

  test("Settings lists the suppliers and edits one in a sheet", async ({ page }) => {
    await signIn(page)
    await go(page, "Settings")
    const section = page.getByTestId("suppliers-section")
    await section.scrollIntoViewIfNeeded()
    await expect(section.getByTestId("supplier-row")).toHaveCount(2)
    await expect(section.getByTestId("supplier-row").first()).toContainText("Games Workshop")
    await expect(section.getByTestId("supplier-row").first()).toContainText("Rep: Dan, 07700 900321")

    await section.getByRole("button", { name: "Edit Asmodee UK" }).click()
    const sheet = page.getByTestId("supplier-sheet")
    const name = sheet.getByLabel("Name", { exact: true })
    await name.fill("Games Workshop")
    await sheet.getByRole("button", { name: "Save supplier" }).click()
    await expect(sheet).toContainText("There is already a supplier called Games Workshop.")
    await name.fill("Asmodee")
    await sheet.getByRole("switch", { name: "Active" }).click()
    await sheet.getByRole("button", { name: "Save supplier" }).click()
    await expect(sheet).toBeHidden()
    await expect(section.getByTestId("suppliers-note")).toHaveText("Asmodee saved.")
    await expect(section.getByTestId("supplier-row").nth(1)).toContainText("Switched off")

    // Switched off, it has no call in the palette.
    await page.keyboard.press("ControlOrMeta+k")
    const palette = page.getByRole("dialog")
    await page.keyboard.type("supplier call")
    await expect(palette.getByText("Supplier call: Games Workshop", { exact: true })).toBeVisible()
    await expect(palette.getByText(/Supplier call: Asmodee/)).toHaveCount(0)
  })
})
