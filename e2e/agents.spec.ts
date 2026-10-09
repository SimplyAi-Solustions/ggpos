import { expect, test, type Page } from "@playwright/test"

/**
 * Agents and research (docs/api-contract-launch.md, section 5), against the
 * demo fixtures at both widths: an admin adds an agent and sees its token
 * and the Hermes config once; a member of staff asks an agent about a
 * trade-in line and sees the comps it found land on the line, as the first
 * price source, and in the Research list.
 *
 * In demo mode the agent Gandalf claims a new request half a second after it
 * is asked and completes it a second later, with three UK sold comps worked
 * out from the demo price book.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

async function signIn(page: Page) {
  await page.goto("/login?demo=1")
  await page.getByLabel("Email").fill(DEMO_EMAIL)
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()
}

async function go(page: Page, action: string) {
  await page.keyboard.press("ControlOrMeta+k")
  const palette = page.getByRole("dialog", { name: "Commands and catalogue search" })
  await expect(palette).toBeVisible()
  await palette.getByText(action, { exact: true }).click()
  await expect(palette).toBeHidden()
}

/** Below 900px a screen's block is docked; take whichever is on screen. */
function primary(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true }).filter({ visible: true })
}

async function confirmPassword(page: Page) {
  const stepUp = page.getByRole("dialog", { name: "Confirm your password to continue" })
  await expect(stepUp).toBeVisible()
  await stepUp.getByLabel("Password").fill(DEMO_PASSWORD)
  await stepUp.getByRole("button", { name: "Continue" }).click()
  await expect(stepUp).toBeHidden()
}

test.describe("agents", () => {
  test("an admin adds an agent and sees its token and the Hermes config once", async ({ page }) => {
    await signIn(page)
    await go(page, "Settings")

    const section = page.getByTestId("agents-section")
    await section.scrollIntoViewIfNeeded()
    await expect(section.getByTestId("agent-row").filter({ hasText: "Gandalf" })).toContainText("Token works until")

    await section.getByRole("button", { name: "Add an agent" }).click()
    const add = page.getByRole("dialog", { name: "Add an agent" })
    await expect(add).toBeVisible()
    // Nothing to add without a name.
    await add.getByRole("button", { name: "Add agent" }).click()
    await expect(add.getByText("Give the agent a name, for example Gandalf.")).toBeVisible()
    await add.getByLabel("Name").fill("Radagast")
    await add.getByLabel("Note").fill("A second Hermes agent for eBay research")
    await add.getByRole("button", { name: "Add agent" }).click()
    await confirmPassword(page)

    const reveal = page.getByRole("dialog", { name: "Radagast’s token" })
    await expect(reveal).toBeVisible()
    await expect(reveal.getByText("Shown once. Copy it now: GG Vault keeps no copy it can show again.")).toBeVisible()
    const token = (await reveal.getByTestId("agent-token").textContent())?.trim() ?? ""
    expect(token.length).toBeGreaterThan(20)
    await expect(reveal.getByTestId("hermes-http")).toContainText("mcp_servers:")
    await expect(reveal.getByTestId("hermes-http")).toContainText("/api/vault/mcp")
    await expect(reveal.getByTestId("hermes-http")).toContainText(`Authorization: "Bearer ${token}"`)
    await expect(reveal.getByTestId("hermes-stdio")).toContainText(`GGVAULT_TOKEN: "${token}"`)
    await expect(reveal.getByTestId("hermes-stdio")).toContainText("services/mcp/stdio.mjs")

    await reveal.getByRole("button", { name: "Done" }).click()
    await expect(reveal).toBeHidden()

    // Once closed, the token is nowhere on the page.
    const radagast = section.getByTestId("agent-row").filter({ hasText: "Radagast" })
    await expect(radagast).toContainText("A second Hermes agent for eBay research")
    await expect(radagast).toContainText("Token works until")
    await expect(page.getByText(token)).toHaveCount(0)

    // A new token stops the old one; the step-up is still fresh, so it does not ask again.
    await radagast.getByRole("button", { name: "New token for Radagast" }).click()
    await expect(radagast).toContainText("current token stops working at once")
    await radagast.getByRole("button", { name: "Make a new token for Radagast" }).click()
    const rekeyed = page.getByRole("dialog", { name: "Radagast’s token" })
    await expect(rekeyed).toBeVisible()
    await expect(rekeyed.getByText("The old token has stopped working. Put this one where it was.")).toBeVisible()
    const second = (await rekeyed.getByTestId("agent-token").textContent())?.trim() ?? ""
    expect(second).not.toBe(token)
    await rekeyed.getByRole("button", { name: "Done" }).click()
    await expect(rekeyed).toBeHidden()

    // Switching off is said in words, and on again needs a new token.
    await radagast.getByRole("button", { name: "Switch off Radagast" }).click()
    await radagast.getByRole("button", { name: "Switch Radagast off now" }).click()
    await expect(radagast).toContainText("Switched off")
    await radagast.getByRole("button", { name: "Switch on Radagast" }).click()
    await expect(radagast).toContainText("No working token. Give it a new one")

    // Gandalf's last actions, from the audit log.
    await section.getByRole("button", { name: "Actions by Gandalf" }).click()
    const actions = page.getByRole("dialog", { name: "Gandalf’s last 50 actions" })
    await expect(actions).toBeVisible()
    await expect(actions.getByTestId("agent-actions")).toContainText("Completed research")
    await page.keyboard.press("Escape")
    await expect(actions).toBeHidden()

    // The research webhook: an address and a secret made here.
    const webhook = section.getByTestId("agent-webhook")
    await webhook.getByLabel("Address").fill("http://mac-mini:8644/webhooks/ggvault-research")
    await webhook.getByRole("button", { name: "Make a secret" }).click()
    await expect(webhook.getByLabel("Secret")).toHaveValue(/^[A-Za-z0-9]{40}$/)
    await webhook.getByRole("button", { name: "Save webhook" }).click()
    await expect(webhook.getByTestId("webhook-saved")).toHaveText("Saved.")
  })

  test("staff ask an agent about a trade-in line and see the comps it found", async ({ page }) => {
    await signIn(page)
    await page.goto("/counter/trade/new")

    await page.getByLabel("Find them").fill("Jasmine")
    await page.getByRole("button", { name: /Jasmine Okafor/ }).click()
    await primary(page, "Add items").click()

    await page.getByLabel("Set and number").fill("sv151 199")
    await page.getByRole("option", { name: /Charizard ex/ }).click()

    const line = page.getByTestId("trade-line").first()
    await expect(line.getByTestId("market-source")).toContainText(/Cardmarket/)
    await line.getByTestId("market-source").click()
    await expect(line.getByTestId("price-sources")).toBeVisible()

    // Search eBay sold: ebay.co.uk's sold and completed listings, in a new tab.
    const ebay = line.getByRole("link", { name: "Search eBay sold" })
    await expect(ebay).toHaveAttribute("target", "_blank")
    const href = (await ebay.getAttribute("href")) ?? ""
    const url = new URL(href)
    expect(url.hostname).toBe("www.ebay.co.uk")
    expect(url.searchParams.get("LH_Sold")).toBe("1")
    expect(url.searchParams.get("LH_Complete")).toBe("1")
    expect(url.searchParams.get("_nkw")).toBe("Charizard ex Scarlet & Violet 151 199/165")

    // Ask an agent: Gandalf claims it, then completes it.
    await line.getByRole("button", { name: "Ask an agent" }).click()
    const result = line.getByTestId("research-result")
    await expect(result).toBeVisible()
    await expect(line.getByRole("button", { name: "Ask an agent" })).toBeDisabled()
    await expect(result.getByTestId("research-status")).toHaveText("Gandalf found 3 sold", { timeout: 10_000 })
    await expect(result.getByTestId("research-comp")).toHaveCount(3)
    await expect(result.getByTestId("research-comp").first()).toContainText("£")
    await expect(result.getByRole("link", { name: "Listing" }).first()).toHaveAttribute(
      "href",
      /^https:\/\/www\.ebay\.co\.uk\/itm\//
    )

    // The comps are UK sold comps now: the line's first source.
    await expect(
      line.locator('[data-testid="price-source"][data-source="uk_sold_manual"]')
    ).toHaveAttribute("data-chosen", "true")

    // And the Research list has it, done, with the same comps.
    await go(page, "Research")
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Research")
    const row = page.getByTestId("research-row").filter({ hasText: "Charizard ex" }).first()
    await expect(row).toHaveAttribute("data-status", "done")
    await expect(row.getByTestId("research-comp")).toHaveCount(3)
    await page.getByRole("button", { name: "Open", exact: true }).click()
    await expect(page.getByTestId("research-row").filter({ hasText: "Charizard ex" })).toHaveCount(0)
  })
})
