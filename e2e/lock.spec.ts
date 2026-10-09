import { expect, test, type Page } from "@playwright/test"

/**
 * The PIN lock, switching user and manager approval, against the demo
 * fixtures at both widths.
 *
 * The demo browser is a registered till from the start, so the lock is the
 * PIN screen with the register's roster. Three demo people have PINs: the
 * demo admin (2580), Mo Khan the manager (1357) and Sam Bell, a member of
 * staff, whose PIN is six digits (482916). The new starter has none.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"
const SAM_EMAIL = "sam@ggentertainment.co.uk"
const SAM_PASSWORD = "ggvault-staff"

async function signIn(page: Page, email = DEMO_EMAIL, password = DEMO_PASSWORD) {
  await page.goto("/login?demo=1")
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Password", { exact: true }).fill(password)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()
}

/** The palette is the one way to every action that works at both widths. */
async function go(page: Page, action: string) {
  await page.keyboard.press("ControlOrMeta+k")
  // The palette by name: the lock screen is a dialog of its own.
  const palette = page.getByRole("dialog", { name: "Commands and catalogue search" })
  await expect(palette).toBeVisible()
  await palette.getByText(action, { exact: true }).click()
  await expect(palette).toBeHidden()
}

function lockScreen(page: Page) {
  return page.getByRole("dialog", { name: "Locked" })
}

async function lock(page: Page) {
  await go(page, "Lock")
  await expect(lockScreen(page)).toBeVisible()
}

/** Below 900px the same action is a second, docked button. */
function primary(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true }).filter({ visible: true })
}

test.describe("the PIN lock", () => {
  test("shows the register's staff and unlocks with a PIN", async ({ page }) => {
    await signIn(page)
    await lock(page)

    const screen = lockScreen(page)
    await expect(screen.getByRole("heading", { level: 1 })).toHaveText("Locked")
    await expect(screen.getByText("Tap your name and enter your PIN.")).toBeVisible()
    await expect(screen.getByTestId("lock-register")).toHaveText("Counter")
    await expect(screen.getByTestId("roster-tile")).toHaveCount(4)
    // A name with no PIN says so, in words.
    await expect(screen.getByRole("button", { name: "New Starter, no pin" })).toBeVisible()

    await screen.getByRole("button", { name: "Demo Counter", exact: true }).click()
    await expect(screen.getByTestId("pin-name")).toHaveText("Demo Counter")
    // The keys on the pad, as a tablet would press them.
    for (const key of ["2", "5", "8", "0"]) {
      await screen.getByRole("button", { name: key, exact: true }).click()
    }
    await expect(screen).toBeHidden()
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()
  })

  test("clears the dots on a wrong PIN and says how many tries are left", async ({ page }) => {
    await signIn(page)
    await lock(page)
    const screen = lockScreen(page)

    await screen.getByRole("button", { name: "Mo Khan", exact: true }).click()
    await page.keyboard.type("1111")
    await expect(screen.getByTestId("pin-error")).toHaveText("That PIN is not right. 4 tries left.")
    await expect(screen.getByRole("img", { name: "0 of 4 digits entered" })).toBeVisible()

    // Back goes to the names; the lock stays.
    await screen.getByRole("button", { name: "Back", exact: true }).click()
    await expect(screen.getByTestId("roster-tile")).toHaveCount(4)
  })

  test("switches user and keeps the screen it was on", async ({ page }) => {
    await signIn(page)
    await page.goto("/counter/stock")
    await expect(page.getByRole("heading", { name: "Stock" })).toBeVisible()
    await lock(page)

    const screen = lockScreen(page)
    await screen.getByRole("button", { name: "Sam Bell", exact: true }).click()
    // Six dots for a six-digit PIN, and the last digit submits.
    await expect(screen.getByRole("img", { name: "0 of 6 digits entered" })).toBeVisible()
    await page.keyboard.type("482916")
    await expect(screen).toBeHidden()

    await expect(page).toHaveURL(/\/counter\/stock$/)
    await expect(page.getByRole("heading", { name: "Stock" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Account menu for Sam Bell" })).toBeVisible()
  })

  test("locks a PIN after five wrong tries until a password sign-in", async ({ page }) => {
    await signIn(page)
    await lock(page)
    const screen = lockScreen(page)

    await screen.getByRole("button", { name: "Sam Bell", exact: true }).click()
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.keyboard.type("111111")
      await expect(screen.getByTestId("pin-error")).toContainText("That PIN is not right.")
    }
    await expect(screen.getByTestId("pin-error")).toHaveText("That PIN is not right. 1 try left.")
    await page.keyboard.type("111111")
    await expect(screen.getByTestId("pin-error")).toHaveText(
      "Too many wrong PINs. Sign in with your password, or ask an admin to reset your PIN."
    )

    await screen.getByRole("button", { name: "Use password instead" }).click()
    await screen.getByLabel("Email").fill(SAM_EMAIL)
    await screen.getByLabel("Password", { exact: true }).fill(SAM_PASSWORD)
    await screen.getByRole("button", { name: "Sign in" }).click()
    await expect(screen).toBeHidden()
    await expect(page.getByRole("button", { name: "Account menu for Sam Bell" })).toBeVisible()

    // The password sign-in cleared the lock on the PIN.
    await lock(page)
    await lockScreen(page).getByRole("button", { name: "Sam Bell", exact: true }).click()
    await page.keyboard.type("482916")
    await expect(lockScreen(page)).toBeHidden()
  })

  test("sends a name with no PIN to the password, and a new starter to the password screen", async ({
    page,
  }) => {
    await signIn(page)
    await lock(page)
    const screen = lockScreen(page)

    await screen.getByRole("button", { name: "New Starter, no pin" }).click()
    await expect(screen.getByText(/has no PIN yet/)).toBeVisible()
    await screen.getByLabel("Email").fill("new@ggentertainment.co.uk")
    await screen.getByLabel("Password", { exact: true }).fill("ggvault-temporary")
    await screen.getByRole("button", { name: "Sign in" }).click()

    await expect(page).toHaveURL(/\/counter\/password$/)
    await expect(page.getByRole("heading", { name: "Set a new password" })).toBeVisible()
  })

  test("locks itself after the minutes Settings gives it", async ({ page }) => {
    await page.clock.install()
    await signIn(page)

    // Five minutes by default (settings.epos.auto_lock_minutes).
    await page.clock.fastForward("04:00")
    await expect(lockScreen(page)).toHaveCount(0)
    await page.clock.fastForward("02:00")
    await expect(lockScreen(page)).toBeVisible()
    await expect(lockScreen(page)).toContainText("DC")
  })

  test("stays locked across a reload, and hears no shortcut", async ({ page }) => {
    await signIn(page)
    await lock(page)

    await page.reload()
    await expect(lockScreen(page)).toBeVisible()

    // `n` is Add stock on the counter; behind the lock it goes nowhere.
    await page.keyboard.press("n")
    await expect(page).toHaveURL(/\/counter$/)
    await expect(lockScreen(page)).toBeVisible()
  })

  test("falls back to the password lock on a browser that is not a till", async ({ page }) => {
    await signIn(page)
    await go(page, "Settings")
    await page.getByTestId("tills-section").scrollIntoViewIfNeeded()
    await page.getByRole("button", { name: "Forget this device" }).click()
    await expect(page.getByText("This browser is not a till.")).toBeVisible()

    await lock(page)
    const screen = lockScreen(page)
    await expect(screen.getByTestId("roster-tile")).toHaveCount(0)
    await screen.getByLabel("Password").fill("wrong")
    await screen.getByRole("button", { name: "Continue" }).click()
    await expect(screen.getByText("That password did not match. Try again.")).toBeVisible()
    await screen.getByLabel("Password").fill(DEMO_PASSWORD)
    await screen.getByRole("button", { name: "Continue" }).click()
    await expect(screen).toBeHidden()
  })
})

test.describe("manager approval", () => {
  test("asks a manager for their PIN and carries on", async ({ page }) => {
    await signIn(page, SAM_EMAIL, SAM_PASSWORD)
    await page.goto("/counter/cash?action=no_sale")

    const sheet = page.getByRole("dialog", { name: "No sale" })
    await expect(sheet).toBeVisible()
    await sheet.getByLabel("Why").fill("Change for the float")
    await sheet.getByRole("button", { name: "Open the drawer" }).click()

    const approval = page.getByTestId("override-dialog")
    await expect(approval).toBeVisible()
    await expect(approval).toContainText("A manager needs to approve this.")
    await expect(approval.getByTestId("override-what")).toHaveText("Open the drawer with no sale")
    // Sam cannot approve their own request, so is not offered.
    await expect(approval.getByRole("button", { name: "Sam Bell", exact: true })).toHaveCount(0)

    await approval.getByRole("button", { name: "Mo Khan", exact: true }).click()
    await page.keyboard.type("9999")
    await expect(approval.getByTestId("pin-error")).toHaveText("That PIN is not right. 4 tries left.")
    await page.keyboard.type("1357")

    await expect(approval).toBeHidden()
    await expect(page.getByTestId("cash-notice")).toContainText("No sale recorded: Change for the float.")
  })

  test("leaves everything as it was when the approval is cancelled", async ({ page }) => {
    await signIn(page, SAM_EMAIL, SAM_PASSWORD)
    await page.goto("/counter/cash?action=z")
    await page.locator("#z-2000").fill("5")
    await page.getByLabel("Tide card total").fill("132.43")
    await primary(page, "Close the till").click()

    const approval = page.getByTestId("override-dialog")
    await expect(approval).toBeVisible()
    await expect(approval.getByTestId("override-what")).toHaveText("Cash up and close Counter")
    await approval.getByRole("button", { name: "Cancel" }).click()
    await expect(approval).toBeHidden()

    // Still on the count, with nothing closed.
    await expect(page.getByTestId("z-close")).toBeVisible()
    await expect(page.locator("#z-2000")).toHaveValue("5")
  })
})

test.describe("your own PIN", () => {
  test("sets a PIN from the account menu and unlocks with it", async ({ page }) => {
    await signIn(page)

    const wide = await page.getByRole("button", { name: /Account menu/ }).isVisible()
    if (wide) {
      await page.getByRole("button", { name: /Account menu/ }).click()
      await page.getByRole("menuitem", { name: "Set PIN" }).click()
    } else {
      await page.getByRole("button", { name: "More" }).click()
      await page.getByRole("button", { name: "Set PIN" }).click()
    }

    const sheet = page.getByRole("dialog", { name: "Set your PIN" })
    await expect(sheet).toBeVisible()
    await sheet.getByLabel("New PIN", { exact: true }).fill("1234")
    await sheet.getByRole("button", { name: "Save PIN" }).click()
    await expect(
      sheet.getByText("Choose a PIN that is not a run or a repeat, such as 1234 or 0000.")
    ).toBeVisible()

    await sheet.getByLabel("New PIN", { exact: true }).fill("7391")
    await sheet.getByLabel("New PIN again").fill("7391")
    await sheet.getByRole("button", { name: "Save PIN" }).click()

    const stepUp = page.getByRole("dialog", { name: "Confirm your password to continue" })
    await expect(stepUp).toBeVisible()
    await stepUp.getByLabel("Password").fill(DEMO_PASSWORD)
    await stepUp.getByRole("button", { name: "Continue" }).click()

    await expect(sheet.getByTestId("pin-saved")).toContainText("Your PIN is set.")
    await sheet.getByRole("button", { name: "Done" }).click()

    await lock(page)
    await lockScreen(page).getByRole("button", { name: "Demo Counter", exact: true }).click()
    await page.keyboard.type("7391")
    await expect(lockScreen(page)).toBeHidden()
  })
})
