import { expect, test, type Page } from "@playwright/test"

/**
 * Staff management, for admins, against the demo fixtures at both widths.
 *
 * Every write asks for the admin's own password once (the step-up), which
 * in demo mode is the demo sign-in's password.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

async function signIn(page: Page, email = DEMO_EMAIL, password = DEMO_PASSWORD) {
  await page.goto("/login?demo=1")
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Password", { exact: true }).fill(password)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()
}

async function go(page: Page, action: string) {
  await page.keyboard.press("ControlOrMeta+k")
  // The palette by name: the lock screen is a dialog of its own.
  const palette = page.getByRole("dialog", { name: "Commands and catalogue search" })
  await expect(palette).toBeVisible()
  await palette.getByText(action, { exact: true }).click()
  await expect(palette).toBeHidden()
}

/** Below 900px a screen's block is docked; take whichever is on screen. */
function primary(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true }).filter({ visible: true })
}

/** The step-up prompt, when it asks; it does not ask twice in ten minutes. */
async function confirmPassword(page: Page) {
  const stepUp = page.getByRole("dialog", { name: "Confirm your password to continue" })
  await expect(stepUp).toBeVisible()
  await stepUp.getByLabel("Password").fill(DEMO_PASSWORD)
  await stepUp.getByRole("button", { name: "Continue" }).click()
  await expect(stepUp).toBeHidden()
}

async function edit(page: Page, name: string) {
  await page.getByRole("button", { name: `Edit ${name}` }).filter({ visible: true }).click()
  const sheet = page.getByRole("dialog", { name })
  await expect(sheet).toBeVisible()
  return sheet
}

test.describe("staff", () => {
  test("lists everybody with their role, status and PIN in words", async ({ page }) => {
    await signIn(page)
    await go(page, "Staff")

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Staff")
    const wide = await page.getByTestId("staff-table").isVisible()
    if (wide) {
      const sam = page.getByTestId("staff-row").filter({ hasText: "Sam Bell" })
      await expect(sam).toContainText("Staff")
      await expect(sam).toContainText("Active")
      await expect(sam).toContainText("Set")
      const starter = page.getByTestId("staff-row").filter({ hasText: "New Starter" })
      await expect(starter).toContainText("None")
      await expect(starter).toContainText("Must change password")
    } else {
      const list = page.getByTestId("staff-list-small")
      await expect(list).toContainText("Manager, PIN set")
      await expect(list).toContainText("Admin, PIN none, must change password")
    }
  })

  test("adds a member of staff with a temporary password", async ({ page }) => {
    await signIn(page)
    await page.goto("/counter/staff")

    await primary(page, "Add member of staff").click()
    const sheet = page.getByRole("dialog", { name: "Add a member of staff" })
    await expect(sheet).toBeVisible()
    await sheet.getByLabel("Name").fill("Jo Price")
    await sheet.getByLabel("Email").fill("mo@ggentertainment.co.uk")
    await sheet.getByRole("button", { name: "Manager" }).click()
    await sheet.getByLabel("Temporary password").fill("short")
    await sheet.getByRole("button", { name: "Add member of staff" }).click()
    await expect(
      sheet.getByText("A temporary password is at least 12 characters. They choose their own at first sign-in.")
    ).toBeVisible()

    await sheet.getByLabel("Temporary password").fill("a-temporary-password")
    await sheet.getByRole("button", { name: "Add member of staff" }).click()
    await confirmPassword(page)
    await expect(sheet.getByText("Somebody already uses that email.")).toBeVisible()

    await sheet.getByLabel("Email").fill("jo@ggentertainment.co.uk")
    await sheet.getByRole("button", { name: "Add member of staff" }).click()
    await expect(sheet).toBeHidden()
    await expect(page.getByTestId("staff-notice")).toHaveText(
      "Jo Price is added as manager. They choose their own password at first sign-in."
    )
    await expect(
      page.getByRole("button", { name: "Edit Jo Price" }).filter({ visible: true })
    ).toBeVisible()
  })

  test("sets and clears a PIN, and sets a temporary password", async ({ page }) => {
    await signIn(page)
    await page.goto("/counter/staff")

    const sheet = await edit(page, "New Starter")
    await expect(sheet.getByTestId("staff-pin-state")).toHaveText("New has no PIN yet.")
    await sheet.getByLabel("New PIN").fill("0000")
    await sheet.getByRole("button", { name: "Set PIN" }).click()
    await expect(sheet.getByTestId("staff-pin-said")).toHaveText(
      "Choose a PIN that is not a run or a repeat, such as 1234 or 0000."
    )
    await sheet.getByLabel("New PIN").fill("640517")
    await sheet.getByRole("button", { name: "Set PIN" }).click()
    await confirmPassword(page)
    await expect(sheet.getByTestId("staff-pin-said")).toHaveText(
      "New's PIN is set, and unlocked if it was locked."
    )
    await expect(sheet.getByTestId("staff-pin-state")).toHaveText("New has a PIN.")

    await sheet.getByRole("button", { name: "Clear PIN" }).click()
    await expect(sheet.getByTestId("staff-pin-said")).toHaveText(
      "New has no PIN now and signs in with a password."
    )

    await sheet.getByLabel("Temporary password").fill("another-temporary-one")
    await sheet.getByRole("button", { name: "Set temporary password" }).click()
    await expect(sheet.getByTestId("staff-password-said")).toHaveText(
      "New signs in with that password once, then chooses their own."
    )
  })

  test("keeps at least one active admin", async ({ page }) => {
    await signIn(page)
    await page.goto("/counter/staff")

    // The new starter is the demo's second admin; make them a manager.
    let sheet = await edit(page, "New Starter")
    await sheet.getByRole("button", { name: "Manager", exact: true }).click()
    await sheet.getByRole("button", { name: "Save changes" }).click()
    await confirmPassword(page)
    await expect(sheet.getByTestId("staff-details-said")).toHaveText("Saved.")
    await page.keyboard.press("Escape")
    await expect(sheet).toBeHidden()

    // Now the demo admin is the last one, and cannot stop being one.
    sheet = await edit(page, "Demo Counter")
    await sheet.getByRole("button", { name: "Staff", exact: true }).click()
    await sheet.getByRole("button", { name: "Save changes" }).click()
    await expect(sheet.getByTestId("staff-details-said")).toHaveText(
      "There has to be at least one active admin."
    )
  })

  test("deactivates somebody, who then drops off the lock screen", async ({ page }) => {
    await signIn(page)
    await page.goto("/counter/staff")

    const sheet = await edit(page, "Sam Bell")
    await sheet.getByRole("switch", { name: "Sam Bell can sign in" }).click()
    await sheet.getByRole("button", { name: "Save changes" }).click()
    await confirmPassword(page)
    await expect(sheet.getByTestId("staff-details-said")).toHaveText(
      "Sam is inactive and signed out everywhere."
    )
    await page.keyboard.press("Escape")

    await go(page, "Lock")
    const lock = page.getByRole("dialog", { name: "Locked" })
    await expect(lock.getByTestId("roster-tile")).toHaveCount(3)
    await expect(lock.getByRole("button", { name: "Sam Bell" })).toHaveCount(0)
  })

  test("is one line for anybody but an admin", async ({ page }) => {
    await signIn(page, "mo@ggentertainment.co.uk", "ggvault-manager")
    await page.goto("/counter/staff")
    await expect(page.getByRole("heading", { name: "Staff" })).toBeVisible()
    await expect(
      page.getByText("Staff accounts are for admins. Ask Richard if somebody needs adding.")
    ).toBeVisible()
    await expect(page.getByTestId("staff-table")).toHaveCount(0)
  })
})
