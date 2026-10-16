import { expect, test, type Locator, type Page } from "@playwright/test"

import { buildCode } from "../packages/shared/src/sku"

/**
 * The stock category tree (docs/api-contract-inventory.md, section 1.6),
 * driven against the demo fixtures at both widths: the till's browse, the
 * picker, the Settings editor, Stock, Add stock and the Sales report.
 *
 * The demo tree is the shared starter tree and lives in memory for the tab,
 * like every other demo store, so a test that changes it moves between
 * screens with the command palette rather than by loading an address.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

/** Mabel is a Magic single, so she is never under Pokémon. */
const MABEL = buildCode("single", "T4M9P")

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

/** Below 900px the same action is a second, docked button. */
function primary(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true }).filter({ visible: true })
}

// ---- The till -------------------------------------------------------------

async function showItems(page: Page) {
  await expect(page.getByTestId("till")).toBeVisible()
  const tab = page.getByRole("tab", { name: /^(Items|Pay|Done)$/ })
  if (await tab.isVisible()) await tab.click()
}

async function openTill(page: Page, how: "address" | "palette" = "address") {
  if (how === "address") {
    await signIn(page)
    await page.goto("/counter/till")
  } else {
    await go(page, "Till")
  }
  await expect(page.getByTestId("till")).toBeVisible()
  await expect(page.getByTestId("till-register")).toContainText("Open")
  await showItems(page)
}

function rail(page: Page, name: string) {
  return page.getByTestId("till-rail").getByRole("button", { name, exact: true })
}

function folder(page: Page, name: string) {
  return page
    .getByTestId("till-folder")
    .filter({ has: page.getByText(name, { exact: true }) })
}

// ---- The picker -------------------------------------------------------------

function picker(page: Page) {
  return page.getByTestId("category-picker")
}

/** Down the tree a level at a time, then the block. */
async function pick(page: Page, path: string[]) {
  const sheet = picker(page)
  await expect(sheet).toBeVisible()
  for (const name of path) {
    await sheet
      .getByTestId("category-picker-rows")
      .getByRole("button")
      .filter({ has: page.getByText(name, { exact: true }) })
      .click()
  }
  await expect(sheet.getByTestId("category-picker-current")).toContainText(path.at(-1) ?? "")
  await sheet.getByRole("button", { name: "Choose this branch" }).click()
  await expect(sheet).toBeHidden()
}

// ---- The Settings editor ------------------------------------------------------

async function openCategories(page: Page): Promise<Locator> {
  await go(page, "Settings")
  const section = page.getByTestId("categories-section")
  await section.scrollIntoViewIfNeeded()
  await expect(section.getByTestId("category-tree")).toBeVisible()
  return section
}

function row(page: Page, name: string) {
  return page.locator(`[data-testid="category-row"][data-name="${name}"]`).first()
}

async function rowAction(page: Page, name: string, action: string) {
  const target = row(page, name)
  await target.scrollIntoViewIfNeeded()
  await target.getByRole("button", { name: `More for ${name}` }).click()
  await page.getByRole("menuitem", { name: action, exact: true }).click()
}

/** A drag by the row's grip onto the edge or the middle of another row. */
async function drag(page: Page, name: string, onto: string, zone: "before" | "inside") {
  const grip = row(page, name).getByTestId("category-grip")
  await grip.evaluate((element) => element.scrollIntoView({ block: "center" }))
  const from = await grip.boundingBox()
  const to = await row(page, onto).boundingBox()
  if (!from || !to) throw new Error("The rows are not on screen.")
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  const y = zone === "before" ? to.y + 4 : to.y + to.height / 2
  await page.mouse.move(to.x + to.width / 2, y, { steps: 10 })
  await page.mouse.up()
}

test.describe("the category tree", () => {
  test("browses the till down to Pokémon > Singles and sells a card from there", async ({ page }) => {
    await openTill(page)
    await expect(rail(page, "Quick")).toHaveAttribute("aria-pressed", "true")

    await rail(page, "Trading cards").click()
    await expect(rail(page, "Trading cards")).toHaveAttribute("aria-pressed", "true")
    await folder(page, "Pokémon").click()
    await folder(page, "Singles").click()

    const trail = page.getByTestId("till-branch-trail")
    await expect(trail).toContainText("Trading cards")
    await expect(trail).toContainText("Pokémon")
    await expect(trail.locator("[aria-current='page']")).toHaveText("Singles")

    await page.getByTestId("till-tile").filter({ hasText: "Charizard ex" }).click()
    await expect(page.getByText("Charizard ex added")).toBeVisible()

    await page.getByTestId("till-pay").filter({ visible: true }).click()
    await expect(page.getByTestId("till-to-pay")).toHaveText("£324.99")
    await showItems(page)
    await page.getByRole("button", { name: "Cash", exact: true }).click()
    await page.keyboard.type("40000")
    await page.getByTestId("till-take-cash").click()
    await expect(page.getByTestId("till-change")).toHaveText("£75.01")
    await page.getByTestId("till-done").getByRole("button", { name: "No receipt" }).click()

    // The branch is still open, and the card has left its shelf.
    await showItems(page)
    await expect(page.getByTestId("till-branch-empty")).toHaveText(
      "Nothing in Singles yet. Scan an item to sell it."
    )

    // Back a level at a time, then to the page the branch was opened from.
    await page.getByTestId("till-branch-back").click()
    await expect(page.getByTestId("till-branch-trail").locator("[aria-current='page']")).toHaveText("Pokémon")
    await page.getByTestId("till-branch-back").click()
    await page.getByTestId("till-branch-back").click()
    await expect(page.getByTestId("till-branch")).toHaveCount(0)
    await expect(rail(page, "Quick")).toHaveAttribute("aria-pressed", "true")
    await expect(page.getByTestId("till-tiles")).toContainText("Table time")
  })

  test("searches within a branch, and still finds a scanned code anywhere", async ({ page }) => {
    await openTill(page)
    await rail(page, "Trading cards").click()
    await folder(page, "Pokémon").click()

    const field = page.getByTestId("till-scan-field")
    await field.fill("charizard")
    const branch = page.getByTestId("till-branch")
    await expect(branch).toContainText("Results in Pokémon")
    await expect(branch.getByTestId("till-tile").filter({ hasText: "Charizard ex" })).toBeVisible()

    await field.fill("mabel")
    await expect(page.getByTestId("till-branch-empty")).toHaveText(
      "Nothing in Pokémon matches that. Check the spelling, or scan the label."
    )

    // A code is not words: it finds Mabel, a Magic card, from inside Pokémon.
    await field.fill(MABEL.display)
    await field.press("Enter")
    await expect(page.getByText("Mabel, Heir to Cragflame added")).toBeVisible()
  })

  test("moves a branch by dragging it in Settings, and the till follows", async ({ page }) => {
    await signIn(page)
    const section = await openCategories(page)

    await drag(page, "Magic: The Gathering", "Pokémon", "before")
    await expect(section.getByTestId("categories-live")).toHaveText(
      "Moved Magic: The Gathering before Pokémon."
    )
    const names = section.getByTestId("category-name")
    await expect(names.nth(1)).toHaveText("Magic: The Gathering")
    await expect(names.nth(2)).toHaveText("Pokémon")

    await openTill(page, "palette")
    await rail(page, "Trading cards").click()
    await expect(page.getByTestId("till-folder").first()).toContainText("Magic: The Gathering")
  })

  test("moves a branch under another through Move to, and the till follows", async ({ page }) => {
    await signIn(page)
    const section = await openCategories(page)

    await rowAction(page, "Drinks and snacks", "Move to")
    const sheet = picker(page)
    await expect(sheet).toContainText("Move Drinks and snacks to")
    // Its own branches are never offered as somewhere to put it.
    await expect(sheet.getByTestId("category-picker-rows")).not.toContainText("Drinks and snacks")
    await pick(page, ["Services"])
    await expect(section.getByTestId("categories-live")).toHaveText(
      "Moved Drinks and snacks into Services, last."
    )

    await openTill(page, "palette")
    await expect(rail(page, "Drinks and snacks")).toHaveCount(0)
    await rail(page, "Services").click()
    await expect(folder(page, "Drinks and snacks")).toBeVisible()
  })

  test("adds a branch, renames it in place, deletes it, and keeps one that is not empty", async ({ page }) => {
    await signIn(page)
    const section = await openCategories(page)
    const live = section.getByTestId("categories-live")

    await rowAction(page, "Pokémon", "Add a branch beneath")
    const sheet = page.getByRole("dialog")
    await expect(sheet).toContainText("Beneath Trading cards / Pokémon, last.")
    await sheet.getByLabel("Name").fill("Promos")
    await sheet.getByRole("button", { name: "Add branch" }).click()
    await expect(live).toHaveText("Promos is added.")
    await expect(row(page, "Promos")).toBeVisible()

    await rowAction(page, "Promos", "Rename")
    const name = page.getByLabel("New name for Promos")
    await name.fill("Promo cards")
    await name.press("Enter")
    await expect(live).toHaveText("Renamed Promos to Promo cards.")

    await rowAction(page, "Promo cards", "Delete")
    await row(page, "Promo cards").getByRole("button", { name: "Delete Promo cards" }).click()
    await expect(live).toHaveText("Promo cards is deleted.")
    await expect(row(page, "Promo cards")).toHaveCount(0)

    // A branch with branches in it stays, in the server's own words.
    await rowAction(page, "Pokémon", "Delete")
    await row(page, "Pokémon").getByRole("button", { name: "Delete Pokémon" }).click()
    await expect(row(page, "Pokémon").getByRole("alert")).toHaveText(
      "Pokémon still holds 4 branches. Move them out or switch the branch off."
    )
  })

  test("switches a branch off, and it leaves the till and the picker", async ({ page }) => {
    await signIn(page)
    await openCategories(page)

    await rowAction(page, "Retro", "Switch off")
    await expect(row(page, "Retro")).toContainText("Switched off")

    await openTill(page, "palette")
    await expect(rail(page, "Trading cards")).toBeVisible()
    await expect(rail(page, "Retro")).toHaveCount(0)

    await go(page, "Stock")
    await page.getByRole("button", { name: "Choose a branch" }).click()
    const sheet = picker(page)
    await expect(sheet.getByTestId("category-picker-rows")).toContainText("Trading cards")
    await expect(sheet.getByTestId("category-picker-rows")).not.toContainText("Retro")
    await sheet.getByLabel("Search every branch").fill("sega")
    await expect(sheet).toContainText("No branch matches that.")
  })

  test("files the Unsorted rows into a branch", async ({ page }) => {
    await signIn(page)
    await openCategories(page)

    const unsorted = row(page, "Unsorted")
    await unsorted.scrollIntoViewIfNeeded()
    await expect(unsorted).toContainText("2")
    await unsorted.getByRole("button", { name: "File these" }).click()

    const list = page.getByTestId("unsorted-rows")
    await expect(list).toContainText("Sonic the Hedgehog 2")
    await expect(list).toContainText("Pikachu plush, 20 cm")
    await page.getByRole("button", { name: "Choose all" }).click()
    await page.getByRole("button", { name: "Choose a branch", exact: true }).click()
    await pick(page, ["Accessories"])

    await expect(page.getByTestId("categories-live")).toHaveText("2 filed in Accessories.")
    await expect(row(page, "Unsorted").getByRole("button", { name: "File these" })).toHaveCount(0)

    await go(page, "Stock")
    await page.getByRole("button", { name: "Choose a branch" }).click()
    await pick(page, ["Accessories"])
    await expect(page.getByTestId("stock-row").filter({ hasText: "Sonic the Hedgehog 2" })).toBeVisible()
  })

  test("adds stock in a branch, which fills in its defaults", async ({ page }) => {
    await signIn(page)
    await page.goto("/counter/stock/new")
    await expect(page.getByRole("heading", { name: "Add stock" })).toBeVisible()

    await page.getByRole("button", { name: "Choose a branch" }).click()
    await pick(page, ["Trading cards", "Pokémon", "Sealed", "Booster packs"])

    await expect(page.getByTestId("stock-branch-path")).toHaveText(
      "Trading cards / Pokémon / Sealed / Booster packs"
    )
    await expect(page.getByTestId("stock-branch-field")).toContainText(
      "Kind, game and VAT treatment filled from Booster packs."
    )
    await expect(page.getByRole("combobox", { name: "Kind" })).toContainText("Sealed product")
    await expect(page.getByRole("combobox", { name: "Game" })).toContainText("Pokemon")
    await expect(page.getByRole("combobox", { name: "VAT" })).toContainText("Standard rate")

    await page.getByLabel("Title").fill("Surging Sparks Booster Pack")
    await page.getByLabel("Cost").fill("3.20")
    await page.getByLabel("Price").fill("4.99")
    await primary(page, "Save item").click()
    await expect(page.getByRole("heading", { name: "Saved" })).toBeVisible()

    // Filed where it was added, and found there.
    await go(page, "Stock")
    await page.getByRole("button", { name: "Choose a branch" }).click()
    await picker(page).getByLabel("Search every branch").fill("pokemon booster packs")
    await picker(page).getByTestId("category-picker-results").getByRole("button").first().click()
    await picker(page).getByRole("button", { name: "Choose this branch" }).click()
    const added = page.getByTestId("stock-row").filter({ hasText: "Surging Sparks Booster Pack" })
    await expect(added).toBeVisible()
    await expect(added.getByTestId("stock-category")).toHaveText("Sealed / Booster packs")
  })

  test("picks the branch up from a barcode already on a stock line", async ({ page }) => {
    // The till puts the demo shelf's sealed stock lines out when it opens.
    await openTill(page)
    await go(page, "Add stock")
    await expect(page.getByRole("heading", { name: "Add stock" })).toBeVisible()

    await page.getByRole("combobox", { name: "Kind" }).click()
    await page.getByRole("option", { name: "Sealed product" }).click()
    await page.getByLabel("EAN").fill("0820650859007")

    await expect(page.getByTestId("stock-branch-path")).toHaveText("Trading cards / Pokémon / Sealed")
    await expect(page.getByTestId("stock-branch-field")).toContainText(
      "Filed with the Prismatic Evolutions Booster Pack already on the shelf."
    )
    await expect(page.getByRole("combobox", { name: "Game" })).toContainText("Pokemon")
  })

  test("shows an item's branch on its page and moves it through Change", async ({ page }) => {
    await signIn(page)
    await go(page, "Stock")
    await page.getByTestId("stock-row").filter({ hasText: "Charizard ex" }).first().click()
    await expect(page.getByTestId("item-branch")).toHaveText("Trading cards / Pokémon / Singles")

    await page.getByRole("button", { name: "Change", exact: true }).click()
    // The picker opens where the item is filed.
    await expect(picker(page).getByTestId("category-picker-current")).toHaveText(
      "Trading cards / Pokémon / Singles"
    )
    await picker(page).getByRole("button", { name: "All branches" }).click()
    await pick(page, ["Trading cards", "Pokémon", "Graded"])
    await expect(page.getByTestId("item-branch")).toHaveText("Trading cards / Pokémon / Graded")
    await expect(page.getByText("Filed in Trading cards / Pokémon / Graded")).toBeVisible()
  })

  test("filters Stock by a branch and everything beneath it, and files ticked rows", async ({ page }) => {
    await signIn(page)
    await go(page, "Stock")
    const rows = page.getByTestId("stock-row")
    await expect(rows.filter({ hasText: "Mabel, Heir to Cragflame" })).toBeVisible()

    await page.getByRole("button", { name: "Choose a branch" }).click()
    await pick(page, ["Trading cards", "Pokémon"])
    await expect(page.getByTestId("stock-branch")).toHaveText("Trading cards / Pokémon")
    const charizard = rows.filter({ hasText: "Charizard ex" })
    await expect(charizard).toBeVisible()
    await expect(charizard.getByTestId("stock-category")).toHaveText("Pokémon / Singles")
    await expect(rows.filter({ hasText: "Mabel, Heir to Cragflame" })).toHaveCount(0)

    // Every branch again, then Mabel ticked and filed under Pokémon.
    await page.getByRole("button", { name: "Every branch" }).click()
    await page.getByLabel("Choose Mabel, Heir to Cragflame").check()
    await expect(page.getByTestId("stock-bulk")).toContainText("1 chosen")
    await page.getByRole("button", { name: "File in a branch" }).click()
    await pick(page, ["Trading cards", "Pokémon", "Singles"])
    await expect(page.getByTestId("stock-bulk")).toHaveText("1 row filed in Pokémon / Singles.")
    await expect(
      rows.filter({ hasText: "Mabel, Heir to Cragflame" }).getByTestId("stock-category")
    ).toHaveText("Pokémon / Singles")
  })

  test("drills the Sales report down by category and keeps the branch in a saved view", async ({ page }) => {
    await signIn(page)
    await go(page, "Reports")
    await page.getByTestId("report-list").getByRole("link", { name: /^Sales/ }).click()
    await expect(page.getByRole("heading", { level: 1, name: "Sales" })).toBeVisible()

    await page.getByRole("combobox", { name: "Break down by" }).click()
    await page.getByRole("option", { name: "Category" }).click()

    const drill = (name: string) =>
      page.getByTestId("report-drill").filter({ hasText: name }).filter({ visible: true })
    await drill("Trading cards").click()
    const trail = page.getByTestId("report-trail")
    await expect(trail.locator("[aria-current='page']")).toHaveText("Trading cards")
    await drill("Pokémon").click()
    await expect(trail.locator("[aria-current='page']")).toHaveText("Pokémon")
    await expect(page.getByTestId("report-table")).toContainText("Singles")

    await page.getByRole("button", { name: "Save view" }).click()
    const sheet = page.getByRole("dialog")
    await sheet.getByLabel("Name").fill("Pokémon by branch")
    await sheet.getByRole("button", { name: "Save view" }).click()
    await expect(sheet).toBeHidden()

    // Back up to the top, then the saved view puts the branch back.
    await trail.getByRole("button", { name: "All branches" }).click()
    await expect(drill("Trading cards")).toBeVisible()
    await page.getByTestId("saved-views").getByText("Pokémon by branch").click()
    await expect(trail.locator("[aria-current='page']")).toHaveText("Pokémon")
    await expect(page.getByTestId("report-table")).toContainText("Singles")
  })
})
