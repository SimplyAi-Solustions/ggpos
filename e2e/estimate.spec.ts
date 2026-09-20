import { expect, test, type Page } from "@playwright/test"

/**
 * The estimate, public and signed in.
 *
 * The public page is the one screen a stranger sees, so it is checked for
 * what it must not do as much as for what it does: no sign-in, no name, no
 * bare figure without the inspection note, and the bands in GBP.
 */

const DEMO_EMAIL = "jasmine.okafor@example.co.uk"
const DEMO_CODE = "48213976"

async function pickCharizard(page: Page) {
  await page.getByLabel("Card").fill("Charizard")
  await page.getByRole("option", { name: /Charizard ex/ }).click()
}

test.describe("the public estimate", () => {
  test("prices a card into a band, with the inspection note", async ({ page }) => {
    await page.goto("/estimate?demo=1")
    await expect(page.getByRole("heading", { name: "What is it worth" })).toBeVisible()

    await pickCharizard(page)

    // £320 market, near mint: the demo bands run 60 percent cash, 75 credit,
    // with the low end priced one grade down.
    await expect(page.getByTestId("estimate-cash")).toHaveText(
      "£163.00 to £192.00"
    )
    await expect(page.getByTestId("estimate-credit")).toHaveText(
      "£204.00 to £240.00"
    )
    await expect(page.getByText("Subject to inspection in the shop.")).toBeVisible()
    await expect(page.getByText(/Market £320\.00/)).toBeVisible()
  })

  test("moves the band when the condition changes", async ({ page }) => {
    await page.goto("/estimate?demo=1")
    await pickCharizard(page)
    const before = await page.getByTestId("estimate-cash").innerText()

    await page.getByRole("button", { name: "Heavily played" }).click()
    await expect(page.getByTestId("estimate-cash")).not.toHaveText(before)
  })

  test("drives a sign-up rather than showing anybody's card", async ({ page }) => {
    await page.goto("/estimate?demo=1")
    await expect(page.getByText(/Join GG Guild at the counter/)).toBeVisible()
    await expect(page.getByRole("link", { name: "Sign in to My Vault" })).toBeVisible()
    // Nothing about a customer, and no bottom bar to a signed-out visitor.
    await expect(page.getByRole("navigation", { name: "Sections" })).toHaveCount(0)
  })

  test("says what to do when nothing matches", async ({ page }) => {
    await page.goto("/estimate?demo=1")
    await page.getByLabel("Card").fill("zzzznothing")
    await expect(
      page.getByText(/Nothing in the catalogue matches that/)
    ).toBeVisible()
  })
})

test.describe("the estimate inside My Vault", () => {
  test("offers the quote and the want list instead of a sign-up", async ({ page }) => {
    await page.goto("/account?demo=1")
    await page.getByLabel("Email").fill(DEMO_EMAIL)
    await page.getByRole("button", { name: "Send me a code" }).click()
    await page.getByLabel("Code", { exact: true }).fill(DEMO_CODE)
    await page.getByRole("button", { name: "Sign in" }).click()
    await expect(page.getByRole("heading", { name: "My card" })).toBeVisible()

    await page.goto("/account/estimate")
    await pickCharizard(page)

    await expect(page.getByTestId("estimate-cash")).toHaveText("£163.00 to £192.00")
    await expect(
      page.getByRole("link", { name: "Send photos for a quote" })
    ).toBeVisible()
    await expect(
      page.getByRole("link", { name: "Add it to my want list" })
    ).toBeVisible()
    await expect(page.getByText(/Join GG Guild at the counter/)).toHaveCount(0)
  })
})
