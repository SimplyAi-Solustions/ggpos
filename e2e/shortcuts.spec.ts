import { expect, test, type Page } from "@playwright/test"

/**
 * The keyboard shortcut overlay at both widths.
 *
 * The one rule that matters is the last test: a question mark typed into a
 * field is a question mark, never a dialog opening over the sale somebody
 * is ringing up.
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

test.describe("the shortcut overlay", () => {
  test("opens on a question mark and closes on Esc", async ({ page }) => {
    await signIn(page)

    await page.keyboard.press("?")
    const overlay = page.getByTestId("shortcut-overlay")
    await expect(overlay).toBeVisible()

    // Every key the counter has, drawn rather than described.
    await expect(overlay).toContainText("Scan")
    await expect(overlay).toContainText("Add stock")
    await expect(overlay).toContainText("New buy-in")
    await expect(overlay).toContainText("Command palette")
    await expect(overlay).toContainText("Keyboard shortcuts")
    await expect(overlay).toContainText("closes any sheet, dialog or menu.")
    await expect(overlay.getByText("Esc", { exact: true })).toBeVisible()

    // A key that needs a modifier is drawn with it: the palette is not
    // plain K, and the page must not say it is.
    await expect(overlay.getByText("Ctrl", { exact: true })).toBeVisible()

    await page.keyboard.press("Escape")
    await expect(overlay).toBeHidden()
  })

  test("keeps the shortcuts to itself while it is open", async ({ page }) => {
    await signIn(page)

    await page.keyboard.press("?")
    const overlay = page.getByTestId("shortcut-overlay")
    await expect(overlay).toBeVisible()

    // Reading the list is not the same as pressing the keys on it.
    await page.keyboard.press("b")
    await expect(overlay).toBeVisible()
    await expect(page).toHaveURL(/\/counter$/)

    await page.keyboard.press("Escape")
    await expect(overlay).toBeHidden()
    await page.keyboard.press("b")
    await expect(page).toHaveURL(/\/counter\/trade/)
  })

  test("never fires on a scanner's own keystrokes", async ({ page }) => {
    await signIn(page)
    await page.goto("/counter/labels")
    await expect(page.getByRole("heading", { name: "Labels" })).toBeVisible()

    // A wedge scanner types a GG code with nothing focused. The S in GGS
    // would otherwise walk off to the Scan screen mid-code.
    for (const key of "GGS7F3K2B") {
      await page.keyboard.press(key, { delay: 5 })
    }
    await page.keyboard.press("Enter")
    await expect(page).not.toHaveURL(/\/counter\/scan/)
  })

  test("is in the command palette for anybody who reached for the mouse", async ({
    page,
  }) => {
    await signIn(page)

    await page.keyboard.press("ControlOrMeta+k")
    const palette = page.getByRole("dialog")
    await expect(palette).toBeVisible()
    await palette.getByText("Keyboard shortcuts", { exact: true }).click()

    await expect(page.getByTestId("shortcut-overlay")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("shortcut-overlay")).toBeHidden()
  })

  test("never opens while the caret is in a field", async ({ page }) => {
    await signIn(page)
    await page.goto("/counter/scan")

    const field = page.getByTestId("scan-field")
    await expect(field).toBeFocused()

    await page.keyboard.press("?")
    await expect(page.getByTestId("shortcut-overlay")).toBeHidden()
    // The question mark went where it was typed.
    await expect(field).toHaveValue("?")
  })
})
