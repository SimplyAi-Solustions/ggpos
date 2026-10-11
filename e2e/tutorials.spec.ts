import { expect, test, type Page } from "@playwright/test"

/**
 * The Tutorials page: the five videos, reached from the account menu on a
 * desktop and from More on a phone, with chapters, every step as text, and a
 * link that opens one video straight away. Playback itself is the browser's
 * own player; what is checked here is that every video and poster the page
 * names is really served, and served in pieces, which is how a player seeks.
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

async function openTutorials(page: Page, phone: boolean) {
  if (phone) {
    await page.getByRole("button", { name: "More" }).click()
    await page.getByRole("button", { name: "Tutorials" }).click()
  } else {
    await page.getByRole("button", { name: /^Account menu/ }).click()
    await page.getByRole("menuitem", { name: "Tutorials" }).click()
  }
  await expect(page.getByRole("heading", { name: "Tutorials", level: 1 })).toBeVisible()
}

test("opens from the menu on the first video, and switches to another", async ({ page }, testInfo) => {
  await signIn(page)
  await openTutorials(page, testInfo.project.name === "phone")

  const player = page.getByTestId("tutorial-player")
  await expect(player.locator("video")).toHaveAttribute("src", /\/tutorials\/01-signing-in\.mp4\?v=/)
  await expect(player.getByRole("heading", { name: "Signing in and the till PIN" })).toBeVisible()
  await expect(page.getByTestId("tutorial-chapters").getByRole("button")).toHaveCount(6)

  const list = page.getByTestId("tutorial-list")
  await expect(list.getByRole("button")).toHaveCount(5)
  await expect(list.getByRole("button", { name: /Signing in and the till PIN/ })).toHaveAttribute("aria-current", "true")

  await list.getByRole("button", { name: /Selling at the till/ }).click()
  await expect(page).toHaveURL(/[?&]t=selling/)
  await expect(player.locator("video")).toHaveAttribute("src", /\/tutorials\/03-selling\.mp4\?v=/)
  await expect(player.getByRole("heading", { name: "Selling at the till" })).toBeVisible()
  await expect(page.getByTestId("tutorial-chapters").getByRole("button")).toHaveCount(8)
  await expect(page.getByTestId("tutorial-chapters")).toContainText("Take payment")
})

test("shows every step as text, and hides it again", async ({ page }) => {
  await signIn(page)
  await page.goto("/counter/tutorials?t=selling")
  await expect(page.getByRole("heading", { name: "Selling at the till" })).toBeVisible()

  const toggle = page.getByRole("button", { name: "Show every step" })
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await toggle.click()
  const steps = page.getByTestId("tutorial-steps")
  await expect(steps.getByRole("button")).toHaveCount(41)
  await expect(steps).toContainText("Key the amount handed over on the money pad")

  await page.getByRole("button", { name: "Hide the steps" }).click()
  await expect(steps).toBeHidden()
})

test("a link names one video, and an unknown one opens the first", async ({ page }) => {
  await signIn(page)
  await page.goto("/counter/tutorials?t=market-values")
  await expect(page.getByRole("heading", { name: "Getting market values" })).toBeVisible()

  await page.goto("/counter/tutorials?t=not-a-tutorial")
  await expect(page.getByRole("heading", { name: "Signing in and the till PIN" })).toBeVisible()
})

test("every video and poster the page names is served", async ({ page, request }) => {
  await signIn(page)
  await page.goto("/counter/tutorials")
  const images = page.getByTestId("tutorial-list").locator("img")
  await expect(images).toHaveCount(5)
  const posters = await images.evaluateAll((imgs) => imgs.map((img) => img.getAttribute("src") ?? ""))
  for (const poster of posters) {
    const image = await request.get(poster)
    expect(image.status(), poster).toBe(200)
    expect(image.headers()["content-type"]).toContain("image/jpeg")

    // Same name and version, the video beside it. Asked for its first
    // kilobyte only, the way a player asks before it seeks.
    const video = poster.replace(/\.jpg\?/, ".mp4?")
    const part = await request.get(video, { headers: { Range: "bytes=0-1023" } })
    expect(part.status(), video).toBe(206)
    expect(part.headers()["content-type"]).toContain("video/mp4")
    expect((await part.body()).length).toBe(1024)
  }
})
