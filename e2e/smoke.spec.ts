import { expect, test } from "@playwright/test"

test("the app shell loads with the GG Vault title", async ({ page }) => {
  await page.goto("/")
  await expect(page).toHaveTitle(/GG Vault/)
  await expect(page.locator("#root")).not.toBeEmpty()
})
