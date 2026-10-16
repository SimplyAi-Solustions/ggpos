import { expect, test, type Page } from "@playwright/test"

/**
 * Receipts and the receipt printer, driven against the demo fixtures.
 *
 * The browser print page is the one screen of this package a person sees
 * outside Settings, and it is the same renderer the Star printer's jobs are
 * drawn by, so it is where the receipt's pixels are checked: 576 dots wide,
 * black and white and nothing between, with ink where the shop name and the
 * total are. In demo mode the page shows the sample receipt, and the Settings
 * section answers from the one demo printer.
 *
 * Both Playwright projects (1440 and 390) run this file. The print page does
 * not change with the viewport, which is the point: it is a sheet of paper.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

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

interface Drawn {
  width: number
  height: number
  /** Pixels that are neither pure black nor pure white. */
  grey: number
  /** Pixels that are not fully opaque. */
  see_through: number
  black: number
  total: number
  /** Black pixels in the top 90 dots, where the shop name is. */
  blackAtTop: number
}

/** Read the receipt image back off the page and count its pixels. */
async function pixels(page: Page): Promise<Drawn> {
  return page.getByTestId("receipt-image").evaluate(async (node) => {
    const image = node as HTMLImageElement
    await image.decode()
    const canvas = document.createElement("canvas")
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("no canvas")
    ctx.drawImage(image, 0, 0)
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let grey = 0
    let seeThrough = 0
    let black = 0
    let blackAtTop = 0
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] ?? 0
      const g = data[i + 1] ?? 0
      const b = data[i + 2] ?? 0
      const a = data[i + 3] ?? 0
      if (a !== 255) seeThrough += 1
      const isBlack = r === 0 && g === 0 && b === 0
      const isWhite = r === 255 && g === 255 && b === 255
      if (!isBlack && !isWhite) grey += 1
      if (isBlack) {
        black += 1
        if (Math.floor(i / 4 / canvas.width) < 90) blackAtTop += 1
      }
    }
    return {
      width: canvas.width,
      height: canvas.height,
      grey,
      see_through: seeThrough,
      black,
      total: canvas.width * canvas.height,
      blackAtTop,
    }
  })
}

const SHEET = "/print/receipt/demo_sale?demo=1&print=0"

test.describe("the browser print page", () => {
  test("draws the receipt 576 dots wide, in one bit, with ink where the shop name is", async ({
    page,
  }) => {
    await page.goto(SHEET)
    const image = page.getByTestId("receipt-image")
    await expect(image).toBeVisible()
    await expect(image).toHaveAttribute("alt", "Receipt GG-S-000456")
    await expect(page.getByText("Receipt GG-S-000456")).toBeVisible()

    const drawn = await pixels(page)
    expect(drawn.width).toBe(576)
    // Tall enough to hold a shop, three lines, a total, tenders, a barcode and a QR.
    expect(drawn.height).toBeGreaterThan(1200)
    // One bit: every pixel is black or white, and opaque.
    expect(drawn.grey).toBe(0)
    expect(drawn.see_through).toBe(0)
    // Ink, but a receipt is mostly paper.
    const share = drawn.black / drawn.total
    expect(share).toBeGreaterThan(0.03)
    expect(share).toBeLessThan(0.3)
    // Anton's shop name sits in the top of the page.
    expect(drawn.blackAtTop).toBeGreaterThan(1500)
  })

  test("shows it 72 mm wide on an 80 mm roll, as a sheet of paper at both viewport widths", async ({
    page,
  }) => {
    await page.goto(SHEET)
    const image = page.getByTestId("receipt-image")
    await expect(image).toBeVisible()
    const box = await image.boundingBox()
    // 72 mm at 96 dpi is 272 px.
    expect(box?.width).toBeGreaterThan(270)
    expect(box?.width).toBeLessThan(275)
    // No sideways scroll at 390.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
    expect(overflow).toBeLessThanOrEqual(0)
  })

  test("prints on a page 80 mm wide and as tall as the receipt", async ({ page }) => {
    await page.goto(SHEET)
    await expect(page.getByTestId("receipt-image")).toBeVisible()
    await page.getByTestId("receipt-image").evaluate((node) => (node as HTMLImageElement).decode())
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true })
    const text = pdf.toString("latin1")
    const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(text)
    expect(box, "the PDF has a MediaBox").not.toBeNull()
    const widthPt = Number(box?.[1])
    const heightPt = Number(box?.[2])
    // 80 mm is 226.8 points.
    expect(widthPt).toBeGreaterThan(226)
    expect(widthPt).toBeLessThan(228)
    // One page of the receipt's own length (72 mm wide per 576 dots), not an A4.
    const drawn = await pixels(page)
    const wantedMm = Math.ceil((drawn.height / 576) * 72) + 2
    const wantedPt = (wantedMm / 25.4) * 72
    expect(Math.abs(heightPt - wantedPt)).toBeLessThan(3)
    expect((text.match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(1)
  })

  test("opens the print dialog once when the receipt is on the page, and not when told to hold it back", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const scope = window as unknown as { __prints: number }
      scope.__prints = 0
      window.print = () => {
        scope.__prints += 1
      }
    })
    await page.goto("/print/receipt/demo_sale?demo=1")
    await expect(page.getByTestId("receipt-image")).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __prints: number }).__prints))
      .toBe(1)

    await page.goto("/print/receipt/demo_sale?demo=1&print=0")
    await expect(page.getByTestId("receipt-image")).toBeVisible()
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(0)
  })

  test("draws a gift receipt shorter than the sale's, with no totals or tenders to carry", async ({
    page,
  }) => {
    await page.goto(SHEET)
    await expect(page.getByTestId("receipt-image")).toBeVisible()
    const sale = await pixels(page)

    await page.goto("/print/receipt/demo_sale?demo=1&print=0&gift=1")
    const image = page.getByTestId("receipt-image")
    await expect(image).toBeVisible()
    await expect(image).toHaveAttribute("alt", "Gift receipt GG-S-000456")
    await expect(image).toHaveAttribute("data-gift", "1")
    const gift = await pixels(page)
    expect(gift.width).toBe(576)
    expect(gift.grey).toBe(0)
    // No totals, VAT table, tenders or customer: a good deal less paper.
    expect(gift.height).toBeLessThan(sale.height - 400)
  })

  test("draws a refund receipt from the refund's reference", async ({ page }) => {
    await page.goto("/print/receipt/demo_sale?demo=1&print=0&refund=GG-S-000456-R1")
    const image = page.getByTestId("receipt-image")
    await expect(image).toBeVisible()
    await expect(image).toHaveAttribute("alt", "Refund receipt GG-S-000456-R1")
    await expect(page.getByText("Receipt GG-S-000456-R1")).toBeVisible()
    const drawn = await pixels(page)
    expect(drawn.width).toBe(576)
    expect(drawn.grey).toBe(0)
  })

  test("says what to do when there is no receipt to draw, not a blank page", async ({ page }) => {
    // Not demo, and no server behind this build: the fetch fails.
    await page.goto("/print/receipt/nothing_here?print=0")
    await expect(page.getByTestId("receipt-error")).toBeVisible()
    await expect(page.getByTestId("receipt-error")).toContainText("could not be drawn")
  })
})

test.describe("Settings, Printers", () => {
  test("lists the printer, takes a new one and shows its URL once", async ({ page }) => {
    await signIn(page)
    await go(page, "Settings")
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible()

    // The Settings screen is another package's file and renders this section
    // once that lands. Until it does there is nothing on the page to drive.
    const section = page.getByTestId("printers-section")
    test.skip(
      (await section.count()) === 0,
      "Settings does not render the Printers section yet."
    )

    const row = section.getByTestId("printer-row")
    await expect(row).toHaveCount(1)
    await expect(row).toContainText("Counter printer")
    await expect(row).toContainText("Star TSP143IV, Counter, 80 mm paper")
    await expect(row.getByTestId("printer-status")).toHaveText("Online")

    await section.getByTestId("add-printer").click()
    const sheet = page.getByRole("dialog")
    await expect(sheet).toBeVisible()
    await sheet.getByLabel("Name").fill("Back printer")
    await sheet.getByLabel(/MAC address/).fill("00-11-E5-06-04-AA")
    await sheet.getByTestId("save-printer").click()

    const url = sheet.getByTestId("printer-url")
    await expect(url).toBeVisible()
    await expect(url).toContainText("/api/vault/cloudprnt/")
    await expect(sheet.getByTestId("printer-url-where")).toHaveText(
      "Printer web settings, CloudPRNT, Server URL. Polling time 2 seconds."
    )

    await sheet.getByRole("button", { name: "Done" }).click()
    await expect(sheet).toBeHidden()
    await expect(page.getByText("/api/vault/cloudprnt/")).toHaveCount(0)
    await expect(section.getByTestId("printer-row")).toHaveCount(2)
    await expect(section.getByText("Not seen yet")).toBeVisible()
  })
})
