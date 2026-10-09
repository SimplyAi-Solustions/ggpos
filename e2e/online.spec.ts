import { join } from "node:path"

import { expect, test, type Page } from "@playwright/test"

import { buildCode } from "../packages/shared/src/sku"

/**
 * Stock on the website and item photos (docs/api-contract-launch.md,
 * section 6), driven against the demo fixtures at both widths: the item
 * page's Website switch and Take photo from a file, the Stock list's bulk
 * action, and Settings, Website with its minimum price and its preview of
 * what the feed sends.
 *
 * The demo stores live in memory for the tab, so a test moves between
 * screens with the command palette rather than by loading an address.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"
const MABEL = buildCode("single", "T4M9P")
/** 800 x 600: a card on a plain background, so the crop to 63:88 shows. */
const PHOTO = join(__dirname, "fixtures", "item-photo.png")

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

test.describe("stock online", () => {
  test("marks an item online, takes a photo from a file and sees it in the feed", async ({ page }) => {
    await signIn(page)
    await page.goto(`/counter/stock/${MABEL.encoded}`)
    await expect(page.getByTestId("item-sku")).toHaveText(MABEL.display)

    // Off the website until somebody says otherwise.
    const website = page.getByTestId("item-website")
    await expect(website.getByTestId("item-website-state")).toHaveText("Not online")
    await expect(website.getByTestId("item-website-note")).toHaveText(
      "Not on the website. Switch it on to list it."
    )
    await website.getByRole("switch", { name: "Show on the website" }).click()
    await expect(website.getByTestId("item-website-state")).toHaveText("Shown online")
    await expect(website.getByTestId("item-website-note")).toHaveText("On the website now.")

    // Take photo, from a file: cropped to the card's 63:88 frame.
    const photos = page.getByTestId("item-photos")
    await expect(photos).toContainText("No photos yet.")
    await photos.getByRole("button", { name: "Take photo" }).click()
    const sheet = page.getByTestId("photo-sheet")
    await expect(sheet).toBeVisible()
    await expect(sheet).toContainText("Cropped to its frame (TCG card)")
    await sheet.getByTestId("photo-file-input").setInputFiles(PHOTO)
    const review = sheet.getByTestId("photo-review")
    await expect(review).toBeVisible()
    await expect(review).toHaveAttribute("src", /^data:image\/jpeg/)
    // 600 tall, 430 wide: the largest 63:88 frame in an 800 x 600 picture.
    await expect
      .poll(() => review.evaluate((image: HTMLImageElement) => `${image.naturalWidth}x${image.naturalHeight}`))
      .toBe("430x600")
    await sheet.getByRole("button", { name: "Save photo" }).click()
    await expect(sheet).toBeHidden()

    await expect(photos.getByTestId("item-photo")).toHaveCount(1)
    await expect(photos.getByTestId("item-photo").first()).toContainText("On the website")
    await expect(photos.getByTestId("item-photo").first().locator("img")).toHaveAttribute("src", /^data:image\/jpeg/)

    // The feed, as Settings previews it: the item, with the photo.
    await go(page, "Settings")
    const section = page.getByTestId("website-section")
    await section.scrollIntoViewIfNeeded()
    const row = section.getByTestId("website-preview-item").filter({ hasText: "Mabel, Heir to Cragflame" })
    await expect(row).toBeVisible()
    await expect(row).toContainText("£12.49")
    await expect(row).toContainText("Lightly played")
    await expect(row.locator("img")).toHaveAttribute("src", /^data:image\/jpeg/)
  })

  test("shows ticked rows online from Stock, and the minimum price keeps them off", async ({ page }) => {
    await signIn(page)
    await go(page, "Stock")
    await expect(page.getByRole("heading", { name: "Stock" })).toBeVisible()

    await page.getByLabel("Choose Charizard ex").check()
    await page.getByLabel("Choose Mabel, Heir to Cragflame").check()
    const bulk = page.getByTestId("stock-bulk")
    await bulk.getByRole("button", { name: "Show online" }).click()
    await expect(bulk).toContainText("2 rows shown on the website.")

    await go(page, "Settings")
    const section = page.getByTestId("website-section")
    await section.scrollIntoViewIfNeeded()
    await expect(section.getByTestId("website-total")).toHaveText("2 items")
    await expect(section.getByTestId("website-preview-item").filter({ hasText: "Charizard ex" })).toBeVisible()

    // A £100 floor keeps the £12.49 Mabel off and the £324.99 Charizard on.
    await section.getByLabel("Minimum price").fill("100.00")
    await section.getByRole("button", { name: "Save website settings" }).click()
    await expect(section.getByTestId("website-saved")).toBeVisible()
    await expect(section.getByTestId("website-total")).toHaveText("1 item")
    await expect(section.getByTestId("website-preview-item")).toHaveCount(1)
    await expect(section.getByTestId("website-preview-item")).toContainText("Charizard ex")

    // Switched off, nothing shows.
    await section.getByRole("switch", { name: "Show stock" }).click()
    await section.getByRole("button", { name: "Save website settings" }).click()
    await expect(section.getByTestId("website-saved")).toBeVisible()
    await expect(section.getByTestId("website-total")).toHaveText("0 items")
    await expect(section).toContainText("Nothing is on the website yet.")

    // Taken off from Stock again.
    await go(page, "Stock")
    await page.getByLabel("Choose Charizard ex").check()
    await page.getByTestId("stock-bulk").getByRole("button", { name: "Take offline" }).click()
    await expect(page.getByTestId("stock-bulk")).toContainText("1 row taken off the website.")
  })
})
