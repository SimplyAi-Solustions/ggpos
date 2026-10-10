/**
 * Screenshots the stock category tree (docs/api-contract-inventory.md,
 * section 1.6) in the states it is judged in: the till's branch view at the
 * top of a branch and down at Pokémon > Singles, the picker part way down
 * the tree and searching, the Settings Categories editor at rest and with
 * a branch mid-drag, and Stock filtered by a branch with a row ticked, at
 * the tablet's 1180x820 and a phone's 390x844, in both colour modes.
 *
 *   VITE_DEMO_SWITCH=1 pnpm --filter web build        # honours ?demo=1
 *   pnpm --filter web exec vite preview --port 4181    # in one terminal
 *   node apps/web/scripts/categories-screens.mjs [baseUrl]
 *
 * Output lands in apps/web/scripts/shots/, which is git-ignored. With
 * SNAP_DIR set, each state in light mode is also saved there as
 * self-contained HTML for the Impeccable detector:
 *
 *   IMPECCABLE_BROWSER=/path/to/chromium \
 *     .claude/skills/impeccable/scripts/bin/linux-x64/impeccable detect "$SNAP_DIR"
 */
import { chromium } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "shots")
const baseUrl = (process.argv[2] ?? "http://127.0.0.1:4181").replace(/\/$/, "")

const VIEWPORTS = [
  { name: "1180x820", width: 1180, height: 820 },
  { name: "390x844", width: 390, height: 844 },
]
const MODES = ["light", "dark"]

/** The same shape lib/auth.ts persists, so the guard lets us straight in. */
const DEMO_STAFF = {
  id: "staff_demo",
  email: "demo@ggentertainment.co.uk",
  name: "Demo Counter",
  role: "admin",
  active: true,
}

const snapDir = process.env.SNAP_DIR

mkdirSync(outDir, { recursive: true })
if (snapDir) mkdirSync(snapDir, { recursive: true })

const browser = await chromium
  .launch({ executablePath: "/opt/pw-browsers/chromium" })
  .catch(() => chromium.launch())

async function open(mode, viewport, path) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    colorScheme: mode,
    hasTouch: viewport.width < 900,
  })
  await context.addInitScript(
    ([theme, staff]) => {
      window.sessionStorage.setItem("gg-demo", "1")
      window.localStorage.setItem("theme", theme)
      window.localStorage.setItem("gg-demo-staff", JSON.stringify(staff))
    },
    [mode, DEMO_STAFF]
  )
  const page = await context.newPage()
  await page.goto(`${baseUrl}${path}?demo=1`, { waitUntil: "networkidle" })
  await page.evaluate(() => document.fonts.ready)
  return { context, page }
}

async function shoot(page, name) {
  await page.waitForTimeout(450)
  await page.screenshot({ path: join(outDir, `${name}.png`) })
  console.log(`shot ${name}`)
}

/** The page as one self-contained file, styles inlined and scripts gone. */
async function snapshot(page, name) {
  if (!snapDir) return
  const html = await page.evaluate(async () => {
    for (const link of Array.from(document.querySelectorAll('link[rel="stylesheet"]'))) {
      const css = await fetch(link.href).then((r) => r.text())
      const style = document.createElement("style")
      style.textContent = css
      link.replaceWith(style)
    }
    for (const script of Array.from(document.querySelectorAll("script"))) script.remove()
    return `<!doctype html>\n${document.documentElement.outerHTML}`
  })
  writeFileSync(join(snapDir, `${name}.html`), html)
}

function folder(page, name) {
  return page.getByTestId("till-folder").filter({ has: page.getByText(name, { exact: true }) })
}

async function pickerRow(page, name) {
  await page
    .getByTestId("category-picker-rows")
    .getByRole("button")
    .filter({ has: page.getByText(name, { exact: true }) })
    .click()
}

for (const mode of MODES) {
  for (const viewport of VIEWPORTS) {
    const tag = `${mode}-${viewport.name}`
    const snap = (page, name) =>
      mode === "light" ? snapshot(page, `${name}-${viewport.name}`) : Promise.resolve()

    // ---- The till's branch view ---------------------------------------------
    {
      const { context, page } = await open(mode, viewport, "/counter/till")
      await page.getByTestId("till").waitFor()
      await page.getByTestId("till-rail").getByRole("button", { name: "Trading cards", exact: true }).click()
      await page.getByTestId("till-branch-tiles").waitFor()
      await shoot(page, `categories-till-top-${tag}`)
      await snap(page, "categories-till-top")

      await folder(page, "Pokémon").click()
      await folder(page, "Singles").click()
      await page.getByTestId("till-tile").filter({ hasText: "Charizard ex" }).waitFor()
      await shoot(page, `categories-till-singles-${tag}`)
      await snap(page, "categories-till-singles")
      await context.close()
    }

    // ---- Stock, its branch filter and the picker -------------------------------
    {
      const { context, page } = await open(mode, viewport, "/counter/stock")
      await page.getByTestId("stock-row").first().waitFor()
      await page.getByRole("button", { name: "Choose a branch" }).click()
      await page.getByTestId("category-picker-rows").waitFor()
      await pickerRow(page, "Trading cards")
      await page.getByTestId("category-picker-current").filter({ hasText: "Trading cards" }).waitFor()
      await shoot(page, `categories-picker-${tag}`)
      await snap(page, "categories-picker")

      await page.getByLabel("Search every branch").fill("singles")
      await page.getByTestId("category-picker-results").waitFor()
      await shoot(page, `categories-picker-search-${tag}`)
      await snap(page, "categories-picker-search")

      await page.getByLabel("Search every branch").fill("")
      await pickerRow(page, "Pokémon")
      await page.getByRole("button", { name: "Choose this branch" }).click()
      await page.getByTestId("stock-branch").filter({ hasText: "Pokémon" }).waitFor()
      await page.getByLabel("Choose Charizard ex").check()
      await page.getByTestId("stock-bulk").waitFor()
      await shoot(page, `categories-stock-filter-${tag}`)
      await snap(page, "categories-stock-filter")
      await context.close()
    }

    // ---- Settings, Categories --------------------------------------------------
    {
      const { context, page } = await open(mode, viewport, "/counter/settings")
      const section = page.getByTestId("categories-section")
      await section.waitFor()
      await section.evaluate((element) => element.scrollIntoView({ block: "start" }))
      await shoot(page, `categories-editor-${tag}`)
      await snap(page, "categories-editor")

      // A branch mid-drag, over the top edge of another: the line and the sentence.
      const grip = page
        .locator('[data-testid="category-row"][data-name="Magic: The Gathering"]')
        .getByTestId("category-grip")
      const target = page.locator('[data-testid="category-row"][data-name="Pokémon"]').first()
      const from = await grip.boundingBox()
      const to = await target.boundingBox()
      if (from && to) {
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
        await page.mouse.down()
        await page.mouse.move(to.x + to.width / 2, to.y + 4, { steps: 8 })
        await shoot(page, `categories-editor-drag-${tag}`)
        await snap(page, "categories-editor-drag")
        await page.keyboard.press("Escape")
        await page.mouse.up()
      }

      // The defaults sheet for a branch that has some.
      await page
        .locator('[data-testid="category-row"][data-name="Pokémon"]')
        .getByRole("button", { name: "More for Pokémon" })
        .click()
      await page.getByRole("menuitem", { name: "Defaults and picture" }).click()
      await page.getByRole("button", { name: "Save defaults" }).waitFor()
      await shoot(page, `categories-defaults-${tag}`)
      await snap(page, "categories-defaults")
      await context.close()
    }
  }
}

await browser.close()
