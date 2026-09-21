import { expect, test, type Page } from "@playwright/test"

/**
 * The forced password change at first sign-in.
 *
 * The demo shop carries two staff accounts: the ordinary one, which is not
 * locked, and a second one in the state a real first admin is in before
 * they have set a password of their own. Signing in with the second is what
 * proves the lock, the refusals and the way out of it, at both of the
 * widths DESIGN.md is judged at (the two Playwright projects).
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

const LOCKED_EMAIL = "new@ggentertainment.co.uk"
const LOCKED_PASSWORD = "ggvault-temporary"
const NEW_PASSWORD = "a-brand-new-counter-password"

const REFUSAL =
  "Choose a password of at least 12 characters, and not the one you are using now."

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login?demo=1")
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Password", { exact: true }).fill(password)
  await page.getByRole("button", { name: "Sign in" }).click()
}

/** Signs the locked account in and waits for the screen it is held on. */
async function signInLocked(page: Page) {
  await signIn(page, LOCKED_EMAIL, LOCKED_PASSWORD)
  await expect(page).toHaveURL(/\/counter\/password$/)
  await expect(page.getByRole("heading", { name: "Set a new password" })).toBeVisible()
}

async function fillChange(page: Page, current: string, next: string, confirm: string) {
  await page.getByLabel("Current password").fill(current)
  await page.getByLabel("New password", { exact: true }).fill(next)
  await page.getByLabel("New password again").fill(confirm)
  await page.getByRole("button", { name: "Save and continue" }).click()
}

test.describe("the first-sign-in password change", () => {
  test("holds a locked staff member on the password screen, with no counter around it", async ({
    page,
  }) => {
    await signInLocked(page)

    await expect(
      page.getByText("This is your first sign-in. Choose a password only you know.")
    ).toBeVisible()

    // No nav on either width: the desktop text links and the phone thumb
    // bar both carry these, and neither is drawn while the account is
    // locked. Nor is the account menu, which is where Sign out lives.
    await expect(page.getByRole("link", { name: "Stock" })).toHaveCount(0)
    await expect(page.getByRole("link", { name: "Trade" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: /Account menu/ })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "More" })).toHaveCount(0)
  })

  test("sends every counter route back to the password screen", async ({ page }) => {
    await signInLocked(page)

    for (const path of ["/counter", "/counter/scan", "/counter/stock", "/counter/settings"]) {
      await page.goto(path)
      await expect(page).toHaveURL(/\/counter\/password$/)
      await expect(page.getByRole("heading", { name: "Set a new password" })).toBeVisible()
    }
  })

  test("leaves the palette and the keyboard shortcuts inert", async ({ page }) => {
    await signInLocked(page)

    await page.keyboard.press("ControlOrMeta+k")
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // `n` is Add stock and `s` is Scan on the counter. Neither listener is
    // registered here, so the screen does not move.
    await page.getByRole("heading", { name: "Set a new password" }).click()
    await page.keyboard.press("n")
    await page.keyboard.press("s")
    await expect(page).toHaveURL(/\/counter\/password$/)
  })

  test("says what is wrong with the password, under the field", async ({ page }) => {
    await signInLocked(page)

    await fillChange(page, LOCKED_PASSWORD, "short-one", "short-one")
    await expect(page.getByText(REFUSAL)).toBeVisible()
    await expect(page).toHaveURL(/\/counter\/password$/)

    await fillChange(page, LOCKED_PASSWORD, LOCKED_PASSWORD, LOCKED_PASSWORD)
    await expect(page.getByText(REFUSAL)).toBeVisible()

    await fillChange(page, LOCKED_PASSWORD, NEW_PASSWORD, "a-different-long-password")
    await expect(
      page.getByText("The two new passwords are different. Type the same one twice.")
    ).toBeVisible()

    await fillChange(page, "not-the-temporary-one", NEW_PASSWORD, NEW_PASSWORD)
    await expect(page.getByText("That password is not right. Try again.")).toBeVisible()
    await expect(page).toHaveURL(/\/counter\/password$/)
  })

  test("takes the new password and lands on Home with the counter back", async ({
    page,
  }) => {
    await signInLocked(page)

    await fillChange(page, LOCKED_PASSWORD, NEW_PASSWORD, NEW_PASSWORD)

    await expect(page).toHaveURL(/\/counter$/)
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()
    await expect(page.getByRole("button", { name: /Account menu/ })).toBeVisible()
  })

  test("does not lock the ordinary demo sign-in", async ({ page }) => {
    await signIn(page, DEMO_EMAIL, DEMO_PASSWORD)

    await expect(page).toHaveURL(/\/counter$/)
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()
  })

  test("opens the same screen from the account menu, without the lock", async ({
    page,
  }) => {
    await signIn(page, DEMO_EMAIL, DEMO_PASSWORD)
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()

    await page.getByRole("button", { name: /Account menu/ }).click()
    await page.getByRole("menuitem", { name: "Change password" }).click()

    await expect(page).toHaveURL(/\/counter\/password$/)
    await expect(page.getByRole("heading", { name: "Set a new password" })).toBeVisible()
    // Not the first sign-in, so it does not say it is, and the counter is
    // still there around the screen.
    await expect(page.getByText("Choose a password only you know.")).toBeVisible()
    await expect(page.getByText("This is your first sign-in.")).toHaveCount(0)
    await expect(page.getByRole("button", { name: /Account menu/ })).toBeVisible()
  })
})
