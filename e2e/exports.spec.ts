import { expect, test, type Page } from "@playwright/test"

/**
 * Exports and imports, against the demo fixtures at both widths.
 *
 * The imports read the file that is actually chosen, so the fixtures below
 * are real CSV text rather than a canned answer: a name-only row really does
 * end up in the review queue, and a row with no custom label really is
 * skipped.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

const CARD_UPLOADER_CSV = [
  "Card Name,Set,Number,Condition,Price,Quantity,TCGplayer ID,Cardmarket ID,Custom Label",
  "Charizard ex,SV151,199,NM,240.00,1,558123,744120,CS-441820",
  "Pikachu VMAX,SWSH045,044,NM,18.50,1,551900,,CS-441821",
  "Mystery holo,,,NM,4.50,1,,,CS-441822",
  "Broken row,,,NM,ask me,1,,,CS-441823",
].join("\r\n")

const EBAY_ORDERS_CSV = [
  "Sales Record Number,Custom Label,Item Number,Sold For,Sale Date,Quantity",
  "17-12345-67890,CS-441820,2551,24.00,2026-09-18,1",
  "17-12345-67891,,2552,9.99,2026-09-18,1",
].join("\r\n")

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

async function openExports(page: Page) {
  await go(page, "Exports and imports")
  await expect(
    page.getByRole("heading", { level: 1, name: "Exports and imports" })
  ).toBeVisible()
}

async function choose(page: Page, label: string, name: string, body: string) {
  await page.getByLabel(label).setInputFiles({
    name,
    mimeType: "text/csv",
    buffer: Buffer.from(body, "utf8"),
  })
}

test.describe("exports and imports", () => {
  test("is reachable from the palette and from the reports index", async ({ page }) => {
    await signIn(page)
    await openExports(page)
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1)

    await go(page, "Reports")
    await page.getByRole("link", { name: "Exports and imports" }).click()
    await expect(
      page.getByRole("heading", { level: 1, name: "Exports and imports" })
    ).toBeVisible()
  })

  test("downloads the SumUp file with its own column headings", async ({ page }) => {
    await signIn(page)
    await openExports(page)

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page
        .getByTestId("export-sumup")
        .getByRole("button", { name: "Download the SumUp items file" })
        .click(),
    ])
    // One black button on this screen, and it is the import.
    await expect(page.locator("[data-variant='circle']")).toHaveCount(0)
    expect(download.suggestedFilename()).toBe("gg-vault-sumup.csv")

    const path = await download.path()
    const text = path ? await (await import("node:fs/promises")).readFile(path, "utf8") : ""
    expect(text.replace(/^\ufeff/, "").split("\r\n")[0]).toBe(
      "Item name,Description,Category,Price,SKU,Barcode,Quantity,Tax rate (%),Variations,Option set 1,Option set 2,Option set 3,Option set 4,Modifiers,Display colour"
    )

    // The row remembers that it has been taken, on this computer.
    await expect(page.getByTestId("export-sumup")).toContainText("Last taken")
  })

  test("previews a Card Uploader file, imports it and leaves a review queue", async ({
    page,
  }) => {
    await signIn(page)
    await openExports(page)

    await choose(page, "Card Uploader CSV", "card-uploader.csv", CARD_UPLOADER_CSV)

    const preview = page.getByTestId("import-preview")
    await expect(preview).toBeVisible()
    await expect(preview).toContainText("4 rows in the file")
    await expect(preview).toContainText("Will import")
    await expect(preview).toContainText("Needs a match")
    await expect(preview).toContainText("Will be skipped")

    await primary(page, "Import the file").click()

    const result = page.getByTestId("import-result")
    await expect(result).toBeVisible()
    await expect(result).toContainText("4 rows read")
    await expect(result).toContainText("The price on this row is not an amount.")

    // The name-only row waits to be matched, with the price the server
    // parsed from the file rather than a guess.
    const queue = page.getByTestId("review-queue")
    await expect(queue.getByTestId("review-row")).toHaveCount(1)
    await expect(queue).toContainText("Mystery holo")
    await expect(queue).toContainText("£4.50")
    await expect(queue).toContainText("CS-441822")
    await queue.getByRole("button", { name: "Skip this row" }).click()
    await expect(page.getByText("Nothing is waiting to be matched.")).toBeVisible()
    await expect(page.getByText("Skipped.")).toBeVisible()
  })

  test("links a reviewed row to a card through the route", async ({ page }) => {
    await signIn(page)
    await openExports(page)
    await choose(page, "Card Uploader CSV", "card-uploader.csv", CARD_UPLOADER_CSV)
    await primary(page, "Import the file").click()

    const queue = page.getByTestId("review-queue")
    await expect(queue.getByTestId("review-row")).toHaveCount(1)

    // The lookup only runs once this row is the one being worked on.
    const field = queue.getByLabel("Find the card")
    await field.click()
    await field.fill("charizard")
    await queue.getByRole("button", { name: /Charizard/ }).first().click()

    // The route owns what happened, and the screen repeats its words.
    await expect(page.getByText("Listed as a new item. It has no cost, so check it.")).toBeVisible()
    await expect(page.getByText("Nothing is waiting to be matched.")).toBeVisible()
    // Its zero-cost note lands with the rest of what the import did.
    await expect(page.getByTestId("import-result")).toContainText(
      "Listed card was not in stock"
    )
  })

  test("refuses a file whose headings it does not recognise", async ({ page }) => {
    await signIn(page)
    await openExports(page)

    await choose(page, "Card Uploader CSV", "nothing.csv", "alpha,beta\r\n1,2\r\n")
    await expect(
      page.getByText(
        "That file is not a CSV we recognise. Check the first line has the column headings."
      )
    ).toBeVisible()
    await expect(primary(page, "Import the file")).toBeDisabled()
  })

  test("imports eBay orders and reports the row it could not match", async ({ page }) => {
    await signIn(page)
    await openExports(page)

    await choose(page, "eBay orders CSV", "orders.csv", EBAY_ORDERS_CSV)
    await expect(page.getByTestId("import-preview")).toContainText("2 rows in the file")

    await primary(page, "Import the file").click()
    const result = page.getByTestId("import-result")
    await expect(result).toBeVisible()
    await expect(result).toContainText("2 rows read")
    await expect(result).toContainText(
      "No custom label on this row, so it matches no item."
    )
  })

  test("lists the listings still to end and clears them once they are", async ({
    page,
  }) => {
    await signIn(page)
    await openExports(page)

    const listings = page.getByTestId("end-listings")
    await expect(listings.locator("li")).toHaveCount(2)

    // Every row is ticked to start with, and the button counts them.
    await expect(page.getByRole("button", { name: "Ended 2 on eBay" })).toBeVisible()
    await listings.getByRole("checkbox").first().uncheck()
    await expect(page.getByRole("button", { name: "Ended 1 on eBay" })).toBeVisible()

    await listings.getByRole("checkbox").first().check()
    await page.getByRole("button", { name: "Ended 2 on eBay" }).click()
    await expect(
      page.getByText("Nothing sold in the shop is still listed on eBay.")
    ).toBeVisible()
  })

  test("says on the spot that a file is too big to import", async ({ page }) => {
    await signIn(page)
    await openExports(page)

    await page.getByLabel("Card Uploader CSV").setInputFiles({
      name: "huge.csv",
      mimeType: "text/csv",
      buffer: Buffer.alloc(11 * 1024 * 1024, "a"),
    })
    await expect(
      page.getByText(
        "That file is over 10 MB. Export a smaller range and import it in parts."
      )
    ).toBeVisible()
    await expect(primary(page, "Import the file")).toBeDisabled()
  })

  test("keeps the admin files to admins", async ({ page }) => {
    await signIn(page)
    await openExports(page)
    await expect(page.getByTestId("export-stock-book")).toBeVisible()
    await expect(page.getByTestId("export-audit")).toBeVisible()

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
      page.getByRole("heading", { level: 1, name: "Exports and imports" })
    ).toBeVisible()
    await expect(page.getByTestId("export-stock-book")).toHaveCount(0)
    await expect(page.getByTestId("export-audit")).toHaveCount(0)
    await expect(page.getByTestId("export-inventory")).toBeVisible()
  })
})
