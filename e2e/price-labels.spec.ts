import { expect, test, type Page } from "@playwright/test"

import { buildCode } from "../packages/shared/src/sku"

/**
 * Print price on the Niimbot D110, at both widths: the sheet from the item
 * page, from ticked rows in Stock and after Add stock, the label drawn as it
 * will print, and what the counter says about the printer.
 *
 * Web Bluetooth is replaced before the app loads: taken away to stand for
 * Brave with its flag off or Safari, or given a printer list the staff
 * member closes without choosing. The print run itself is unit tested
 * against niimbluelib (`features/price-labels/niimbot.test.ts`).
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

/** The demo Charizard. */
const CHARIZARD = buildCode("single", "7F3K2")

async function signIn(page: Page) {
  await page.goto("/login?demo=1")
  await page.getByLabel("Email").fill(DEMO_EMAIL)
  await page.getByLabel("Password").fill(DEMO_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()
}

/** A browser with no Web Bluetooth at all. */
async function noBluetooth(page: Page) {
  await page.addInitScript(() => {
    Reflect.deleteProperty(Navigator.prototype, "bluetooth")
    Reflect.deleteProperty(navigator, "bluetooth")
  })
}

/** Web Bluetooth whose printer list is closed with nothing picked. */
async function pickerClosed(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "bluetooth", {
      configurable: true,
      value: {
        getDevices: async () => [],
        requestDevice: () =>
          Promise.reject(new DOMException("User cancelled the requestDevice() chooser.", "NotFoundError")),
      },
    })
  })
}

function visible(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true }).filter({ visible: true })
}

test.describe("price labels", () => {
  test("the item page draws the label at 40 by 12 mm and starts on one", async ({ page }) => {
    await pickerClosed(page)
    await signIn(page)
    await page.goto(`/counter/stock/${CHARIZARD.encoded}`)
    await expect(page.getByTestId("item-sku")).toHaveText(CHARIZARD.display)

    await visible(page, "Print price").click()
    const sheet = page.getByTestId("price-label-sheet")
    await expect(sheet.getByRole("heading", { name: "Print price" })).toBeVisible()

    // The label as it prints: 320 x 96 dots, one bit, the logo and the price.
    const image = sheet.getByTestId("price-label-preview").locator("img")
    await expect(image).toBeVisible()
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => `${img.naturalWidth}x${img.naturalHeight}`))
      .toBe("320x96")
    const ink = await image.evaluate((img: HTMLImageElement) => {
      const canvas = document.createElement("canvas")
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext("2d")
      if (!ctx) return { grey: -1, black: 0 }
      ctx.drawImage(img, 0, 0)
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      let grey = 0
      let black = 0
      for (let i = 0; i < data.length; i += 4) {
        const value = data[i] ?? 0
        if (value !== 0 && value !== 255) grey += 1
        if (value === 0) black += 1
      }
      return { grey, black }
    })
    expect(ink.grey).toBe(0)
    expect(ink.black).toBeGreaterThan(500)

    await expect(sheet.getByTestId("price-label-row")).toHaveCount(1)
    await expect(sheet.getByRole("textbox", { name: /^Labels for / })).toHaveValue("1")
    await expect(sheet.getByTestId("price-label-printer-status")).toHaveText(
      "Not connected. Print asks you to pick the D110 first."
    )

    await sheet.getByRole("button", { name: "One more" }).click()
    const print = sheet.getByTestId("price-label-print")
    await expect(print).toHaveText(/Print 2 labels/)

    // The list closed with nothing picked says so, and prints nothing.
    await print.click()
    await expect(sheet.getByTestId("price-label-error")).toHaveText(
      "No printer was chosen. Press Connect printer and pick the D110 from the list."
    )
    await expect(sheet.getByTestId("price-label-printer-status")).toHaveText(
      "Not connected. Print asks you to pick the D110 first."
    )
  })

  test("a browser without Web Bluetooth says where to print from", async ({ page }) => {
    await noBluetooth(page)
    await signIn(page)
    await page.goto(`/counter/stock/${CHARIZARD.encoded}`)
    await visible(page, "Print price").click()
    const sheet = page.getByTestId("price-label-sheet")
    await expect(sheet.getByTestId("price-label-printer-status")).toContainText(
      "This browser cannot reach a Bluetooth printer. Open GG Vault in Chrome or Edge on the Mac mini."
    )
    await expect(sheet.getByTestId("price-label-print")).toBeDisabled()
    // The label still shows, so the price can be checked from a phone.
    await expect(sheet.getByTestId("price-label-preview").locator("img")).toBeVisible()
  })

  test("ticked rows in Stock print one label per unit", async ({ page }) => {
    await pickerClosed(page)
    await signIn(page)
    await page.goto("/counter/stock")
    await page.getByLabel("Search stock").fill("Nuln Oil")
    const row = page.getByTestId("stock-row").filter({ hasText: "Citadel Shade: Nuln Oil" })
    await expect(row).toHaveCount(1)
    await row.getByRole("checkbox").check()

    await page.getByTestId("stock-bulk").getByRole("button", { name: "Print prices" }).click()
    const sheet = page.getByTestId("price-label-sheet")
    await expect(sheet.getByRole("heading", { name: "Print price" })).toBeVisible()
    await expect(sheet.getByTestId("price-label-row")).toContainText("Citadel Shade: Nuln Oil")
    await expect(sheet.getByTestId("price-label-row")).toContainText("£4.70")
    await expect(sheet.getByRole("textbox", { name: "Labels for Citadel Shade: Nuln Oil" })).toHaveValue("3")
    await expect(sheet.getByTestId("price-label-print")).toHaveText(/Print 3 labels/)

    // The roll is this browser's: it is still chosen next time.
    await sheet.getByRole("combobox", { name: "Label" }).click()
    await page.getByRole("option", { name: "12 x 30 mm" }).click()
    await expect
      .poll(() =>
        sheet
          .getByTestId("price-label-preview")
          .locator("img")
          .evaluate((img: HTMLImageElement) => `${img.naturalWidth}x${img.naturalHeight}`)
      )
      .toBe("240x96")
    await sheet.getByRole("button", { name: "Cancel" }).click()
    await expect(sheet).toBeHidden()
    await page.getByTestId("stock-bulk").getByRole("button", { name: "Print prices" }).click()
    await expect(page.getByTestId("price-label-sheet").getByRole("combobox", { name: "Label" })).toContainText(
      "12 x 30 mm"
    )
  })

  test("Add stock offers one label per unit that came in", async ({ page }) => {
    await pickerClosed(page)
    await signIn(page)
    await page.goto("/counter/stock/new")
    await page.getByRole("combobox", { name: "Kind" }).click()
    await page.getByRole("option", { name: "Sealed product" }).click()
    await page.getByRole("combobox", { name: "Game" }).click()
    await page.getByRole("option", { name: "Pokemon" }).click()
    await page.getByLabel("Title").fill("Surging Sparks Booster Pack")
    await page.getByRole("button", { name: "One more" }).click()
    await page.getByRole("button", { name: "One more" }).click()
    await expect(page.getByLabel("Quantity")).toHaveValue("3")
    await page.getByLabel("Cost").fill("3.00")
    await page.getByLabel("Price").fill("5.49")
    await visible(page, "Save item").click()
    await expect(page.getByRole("heading", { name: "Saved" })).toBeVisible()

    await page.getByRole("button", { name: "Print price" }).click()
    const sheet = page.getByTestId("price-label-sheet")
    await expect(sheet.getByTestId("price-label-row")).toContainText("Surging Sparks Booster Pack")
    await expect(sheet.getByTestId("price-label-row")).toContainText("£5.49")
    await expect(sheet.getByRole("textbox", { name: /^Labels for / })).toHaveValue("3")
    await expect(sheet.getByTestId("price-label-print")).toHaveText(/Print 3 labels/)
  })
})
