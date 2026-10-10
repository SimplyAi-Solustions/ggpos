import { expect, test, type Page } from "@playwright/test"

/**
 * After an update, a page opened on the build before asks for a screen file
 * that is no longer on the server, and gets the app's page back instead
 * ("text/html is not a valid JavaScript MIME type"). The app should reload
 * itself onto the new build rather than leave the screen dead
 * (apps/web/src/lib/stale-build.ts).
 *
 * The service worker is blocked so every request reaches page.route, which
 * plays the server that no longer has the file: the first script asked for
 * after the counter is up comes back as HTML, once.
 */

test.use({ serviceWorkers: "block" })

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

async function signIn(page: Page) {
  await page.goto("/login?demo=1")
  await page.getByLabel("Email").fill(DEMO_EMAIL)
  await page.getByLabel("Password").fill(DEMO_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()
}

test("a screen file missing after an update reloads the page onto the new build", async ({ page }) => {
  await signIn(page)

  let loads = 0
  page.on("load", () => {
    loads += 1
  })
  let missing = ""
  await page.route("**/assets/*.js", async (route) => {
    if (missing) return route.continue()
    missing = route.request().url()
    await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><html><body></body></html>" })
  })

  await page.keyboard.press("ControlOrMeta+k")
  const palette = page.getByRole("dialog")
  await expect(palette).toBeVisible()
  await palette.getByText("Reports", { exact: true }).click()

  await expect.poll(() => loads, { timeout: 15_000 }).toBeGreaterThan(0)
  expect(missing).not.toBe("")

  // The reloaded page works: the counter is there and Reports opens.
  await page.goto("/counter/reports?demo=1")
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible()
})
