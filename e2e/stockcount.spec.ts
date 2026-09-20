import { expect, test, type Page } from "@playwright/test"

import { buildCode } from "../packages/shared/src/sku"

/**
 * A stock count of one location, scanned through and closed against the
 * variance, at both widths.
 *
 * The demo counter holds the Charizard in the Showcase and the Mabel in
 * Binder A, so scanning the Mabel into a Showcase count is the "recorded
 * somewhere else" case without any setup.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

const SHOWCASE_ITEM = buildCode("single", "7F3K2") // Charizard ex, Showcase
const BINDER_ITEM = buildCode("single", "T4M9P") // Mabel, Binder A
const NOT_OURS = buildCode("single", "Z9Z9Z")

async function signIn(page: Page) {
  await page.goto("/login?demo=1")
  await page.getByLabel("Email").fill(DEMO_EMAIL)
  await page.getByLabel("Password").fill(DEMO_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()
}

function primary(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true }).filter({ visible: true })
}

async function go(page: Page, action: string) {
  await page.keyboard.press("ControlOrMeta+k")
  const palette = page.getByRole("dialog")
  await expect(palette).toBeVisible()
  await palette.getByText(action, { exact: true }).click()
  await expect(palette).toBeHidden()
}

async function scan(page: Page, code: string) {
  const field = page.getByTestId("count-scan-field")
  await field.fill(code)
  await field.press("Enter")
}

test.describe("stock counts", () => {
  test("counts a location, flags what does not belong, and closes on the variance", async ({
    page,
  }) => {
    await signIn(page)
    await go(page, "Stock count")
    await expect(page.getByRole("heading", { name: "Stock count" })).toBeVisible()

    await page.getByRole("button", { name: "Showcase", exact: true }).click()
    await primary(page, "Start count").click()

    // The snapshot: one item is recorded in the Showcase.
    await expect(page.getByTestId("count-scan-field")).toBeVisible()
    await expect(page.getByTestId("count-expected")).toHaveText("1")
    await expect(page.getByTestId("count-missing")).toHaveText("1")
    await expect(page.getByTestId("missing-lines")).toContainText("Charizard ex")

    // Ticking the expected item off.
    await scan(page, SHOWCASE_ITEM.display)
    await expect(page.getByTestId("count-scan-note")).toHaveText("Charizard ex found.")
    await expect(page.getByTestId("count-scanned")).toHaveText("1")
    await expect(page.getByTestId("count-missing")).toHaveText("0")

    // Something the shelf should not be holding says where it belongs.
    await scan(page, BINDER_ITEM.display)
    await expect(page.getByTestId("count-scan-note")).toHaveText(
      `${BINDER_ITEM.display} is not expected here. It is recorded at Binder A.`
    )
    await expect(page.getByTestId("count-unexpected")).toHaveText("1")
    await expect(page.getByTestId("extra-lines")).toContainText("Binder A")

    // A code we do not hold at all.
    await scan(page, NOT_OURS.display)
    await expect(
      page.getByText(`${NOT_OURS.display} is not a code we hold. Check the label.`)
    ).toBeVisible()

    // Closing it, moving what turned up here to here.
    await primary(page, "Close count").click()
    const sheet = page.getByRole("dialog")
    await expect(sheet).toContainText("1 expected, 2 found, 0 missing, 1 not expected here")
    await sheet.getByRole("switch", { name: /Move the unexpected items/ }).click()
    await sheet.getByRole("button", { name: "Close count" }).click()

    await expect(page.getByTestId("count-closed")).toBeVisible()
    await expect(page.getByTestId("count-closed")).toContainText("1 expected, 2 found")
    await expect(page.getByTestId("count-scan-field")).toHaveCount(0)

    // The past counts list carries the variance.
    await go(page, "Stock count")
    const row = page.getByTestId("count-row").first()
    await expect(row).toContainText("Showcase")
    await expect(row).toContainText("Closed")
  })

  test("carries on with the count already open rather than starting a second", async ({
    page,
  }) => {
    await signIn(page)
    await go(page, "Stock count")
    await page.getByRole("button", { name: "Binder A", exact: true }).click()
    await primary(page, "Start count").click()
    await expect(page.getByTestId("count-scan-field")).toBeVisible()
    const url = page.url()

    await go(page, "Stock count")
    await page.getByRole("button", { name: "Binder A", exact: true }).click()

    await expect(page.getByTestId("count-resume")).toContainText(
      "A count of Binder A is already open"
    )
    await primary(page, "Carry on counting").click()
    await expect(page).toHaveURL(url)
  })

  test("leaves the close to an admin", async ({ page }) => {
    await page.addInitScript(() => {
      window.sessionStorage.setItem("gg-demo", "1")
      window.localStorage.setItem(
        "gg-demo-staff",
        JSON.stringify({
          id: "staff_demo",
          email: "demo@ggentertainment.co.uk",
          name: "Demo Counter",
          role: "staff",
          active: true,
        })
      )
    })
    await page.goto("/counter/stock/count?demo=1")

    await page.getByRole("button", { name: "Binder A", exact: true }).click()
    await primary(page, "Start count").click()
    await expect(page.getByTestId("count-scan-field")).toBeVisible()

    // Staff run the count; the variance goes on the record, so an admin closes it.
    await expect(primary(page, "Close count")).toBeDisabled()
    await expect(
      page.getByText("An admin closes a count, because the variance goes on the record.")
    ).toBeVisible()
  })
})
