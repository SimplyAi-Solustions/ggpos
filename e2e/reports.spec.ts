import { expect, test, type Page } from "@playwright/test"

/**
 * The reports suite, driven against the demo fixtures at both widths.
 *
 * The demo figures are generated from the date they belong to, so they are
 * the same on every run of a given day but not the same on two different
 * days. Nothing here asserts a literal amount: it asserts the shape money is
 * written in, which is the rule that actually matters.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

/** £1,234.56, and never 45p or a bare number. */
const MONEY = /^-?£\d{1,3}(,\d{3})*\.\d{2}$/

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

async function openReport(page: Page, name: string) {
  await go(page, "Reports")
  await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible()
  // The report list, not the nav: "Stock" is a link in both.
  await page
    .getByTestId("report-list")
    .getByRole("link", { name: new RegExp(`^${name}`) })
    .click()
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible()
}

test.describe("reports", () => {
  test("lists the nine reports and opens one", async ({ page }) => {
    await signIn(page)
    await go(page, "Reports")

    const rows = page.getByTestId("report-list").getByRole("link")
    await expect(rows).toHaveCount(9)
    for (const name of [
      "Sales",
      "Buy-ins",
      "Margin",
      "Stock",
      "Channels",
      "Customers",
      "Loyalty",
      "Cash",
      "Compliance",
    ]) {
      await expect(rows.filter({ hasText: name }).first()).toBeVisible()
    }

    await rows.first().click()
    await expect(page.getByRole("heading", { level: 1, name: "Sales" })).toBeVisible()
    // One Anton line per screen, on the report as well as on the index.
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1)
  })

  test("shows figures, a comparison and a table for the range", async ({ page }) => {
    await signIn(page)
    await openReport(page, "Sales")

    // Last 30 days is the range a report opens on.
    await expect(page.getByTestId("range-line")).toContainText("against")

    const revenue = page.getByTestId("kpi-revenue")
    await expect(revenue).toBeVisible()
    await expect(revenue).toHaveText(MONEY)

    // The chart is drawn for sighted readers and summarised for everybody
    // else; the table under it is the same data in a form that can be walked.
    await expect(page.getByTestId("report-table")).toBeVisible()
    await expect(page.locator("figure[data-slot='report-chart'] figcaption")).toHaveCount(1)

    // The heatmap is on Sales and nowhere else.
    await expect(page.getByRole("heading", { name: "When the shop is busy" })).toBeVisible()
  })

  test("moves the range and the comparison with the preset chips", async ({ page }) => {
    await signIn(page)
    await openReport(page, "Sales")

    const line = page.getByTestId("range-line")
    const before = await line.textContent()

    await page.getByTestId("preset-today").click()
    await expect(line).not.toHaveText(before ?? "")
    // One day compared with the day before it.
    await expect(line).toContainText("against")

    await page.getByTestId("preset-custom").click()
    await expect(page.getByLabel("From")).toBeVisible()
    await page.getByLabel("From").fill("2026-09-30")
    await page.getByLabel("To").fill("2026-09-01")
    await expect(
      page.getByText("The from date is after the to date. Swap them over.")
    ).toBeVisible()
  })

  test("exports the table as a CSV of pounds and pence", async ({ page }) => {
    await signIn(page)
    await openReport(page, "Sales")
    await expect(page.getByTestId("report-table")).toBeVisible()

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      primary(page, "Export CSV").click(),
    ])

    expect(download.suggestedFilename()).toMatch(
      /^gg-vault-sales-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/
    )

    const path = await download.path()
    const text = path ? await (await import("node:fs/promises")).readFile(path, "utf8") : ""
    const lines = text.replace(/^\ufeff/, "").trim().split("\r\n")
    expect(lines[0]).toBe("Name,Revenue,Sales")
    // Every money cell is pounds and pence, never pence, never a pound sign
    // and never a bare "5" where 500 pence was meant.
    for (const line of lines.slice(1)) {
      const [, revenue, count] = line.split(",")
      expect(revenue).toMatch(/^-?\d+\.\d{2}$/)
      expect(count).toMatch(/^\d+$/)
    }
  })

  test("adds its own figures up the way the generator does", async ({ page }) => {
    await signIn(page)
    await openReport(page, "Sales")
    await expect(page.getByTestId("report-table")).toBeVisible()

    const pounds = async (testId: string) =>
      Number(((await page.getByTestId(testId).textContent()) ?? "").replace(/[£,]/g, ""))

    // The demo splits the range's revenue across the breakdown exactly, so
    // the rows have to add back up to the headline penny for penny. The
    // table's own cells, not the whole subtree: the summary list below
    // 900px carries the same figures again.
    const revenue = await pounds("kpi-revenue")
    const cells = await page
      .getByTestId("report-table")
      .locator("table tbody td[data-numeric]")
      .allTextContents()
    const rowTotal = cells
      .filter((cell) => cell.startsWith("£"))
      .reduce((carry, cell) => carry + Number(cell.replace(/[£,]/g, "")), 0)
    expect(rowTotal).toBeGreaterThan(0)
    expect(Math.abs(rowTotal - revenue)).toBeLessThan(0.005)

    // And the average basket is the revenue over the count, to the penny.
    const count = Number(
      ((await page.getByTestId("kpi-count").textContent()) ?? "").replace(/,/g, "")
    )
    const basket = await pounds("kpi-avg_basket")
    expect(count).toBeGreaterThan(0)
    expect(Math.round(basket * 100)).toBe(Math.round((revenue * 100) / count))
  })

  test("says what is empty rather than drawing a blank chart", async ({ page }) => {
    await signIn(page)
    await openReport(page, "Sales")

    // A week that has not happened yet: the shape is right, the figures are
    // all zero, and the page has to say so.
    await page.getByTestId("preset-custom").click()
    await page.getByLabel("From").fill("2027-01-01")
    await page.getByLabel("To").fill("2027-01-07")

    await expect(page.getByTestId("report-empty")).toBeVisible()
    await expect(page.getByTestId("report-empty")).toContainText(
      "between 1 and 7 Jan 2027"
    )
    await expect(page.getByTestId("kpi-revenue")).toHaveText("£0.00")
    await expect(page.locator("figure[data-slot='report-chart']")).toHaveCount(0)
  })

  test("saves a view and offers it back under the title", async ({ page }) => {
    await signIn(page)
    await openReport(page, "Margin")

    await page.getByRole("button", { name: "Save view" }).click()
    const sheet = page.getByRole("dialog")
    await expect(sheet).toBeVisible()
    await sheet.getByLabel("Name").fill("Margin, my view")
    await sheet.getByRole("button", { name: "Save view" }).click()
    await expect(sheet).toBeHidden()

    await expect(
      page.getByTestId("saved-views").getByText("Margin, my view")
    ).toBeVisible()
  })

  test("draws no chart on the reports that have no series", async ({ page }) => {
    await signIn(page)
    await openReport(page, "Stock")

    // Stock is a point in time, so there is no period chart, only figures
    // and tables.
    await expect(page.locator("figure[data-slot='report-chart']")).toHaveCount(0)
    await expect(page.getByTestId("report-table")).toBeVisible()
    await expect(page.getByRole("heading", { name: "How long it is held" })).toBeVisible()
    // Stock is read as it stands now, so no comparison is offered at all.
    await expect(page.getByLabel("Compare with the period before")).toHaveCount(0)
    // The ageing buckets read in words, never as a raw key.
    await expect(page.getByText("Date not known").filter({ visible: true })).toHaveCount(1)
  })

  test("keeps the register for admins", async ({ page }) => {
    await signIn(page)
    await openReport(page, "Compliance")
    await expect(page.getByTestId("report-table")).toBeVisible()

    await page.evaluate(() => {
      const raw = window.localStorage.getItem("gg-demo-staff")
      if (!raw) return
      window.localStorage.setItem(
        "gg-demo-staff",
        JSON.stringify({ ...JSON.parse(raw), role: "staff" })
      )
    })
    await page.reload()
    await expect(
      page.getByText("The buy-in register is for admins.")
    ).toBeVisible()
    await expect(page.getByTestId("report-table")).toHaveCount(0)
  })

  test("puts a 30-day line under each Home tile", async ({ page }) => {
    await signIn(page)
    const tiles = page.getByTestId("today-tiles")
    await expect(tiles.locator("svg[data-slot='sparkline']")).toHaveCount(4)
    // No axes, no fill: one polyline in ink.
    await expect(tiles.locator("svg[data-slot='sparkline'] polyline").first()).toHaveAttribute(
      "fill",
      "none"
    )
  })
})
