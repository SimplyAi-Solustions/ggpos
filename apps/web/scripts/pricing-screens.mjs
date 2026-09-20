/**
 * Screenshots the Phase 3 live-pricing screens, signed in against the demo
 * fixtures: Add stock with a card chosen and its sources, the source view on
 * its own, price-check mode on Scan, and a buy-in line priced from a source.
 *
 *   pnpm --filter web build
 *   pnpm --filter web exec vite preview --port 4173   # in one terminal
 *   node apps/web/scripts/pricing-screens.mjs [baseUrl]
 *
 * Output lands in apps/web/scripts/shots/, which is git-ignored.
 * `screenshots.mjs` covers the kit page and the two reference rebuilds,
 * `screens.mjs` scan, stock, sell, cash and labels,
 * `customers-trade-screens.mjs` the customers area and the buy-in wizard, and
 * `settings-offline-count-screens.mjs` settings, the offline strip and counts.
 */
import { chromium } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "shots")
const baseUrl = (process.argv[2] ?? "http://127.0.0.1:4173").replace(/\/$/, "")

const VIEWPORTS = [
  { name: "1440x1200", width: 1440, height: 1200 },
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

mkdirSync(outDir, { recursive: true })

const browser = await chromium
  .launch({ executablePath: "/opt/pw-browsers/chromium" })
  .catch(() => chromium.launch())

async function open(mode, viewport, path) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    colorScheme: mode,
  })
  await context.addInitScript(
    ([theme, session]) => {
      window.sessionStorage.setItem("gg-demo", "1")
      window.localStorage.setItem("theme", theme)
      window.localStorage.setItem("gg-demo-staff", JSON.stringify(session))
    },
    [mode, DEMO_STAFF]
  )
  const page = await context.newPage()
  const q = path.includes("?") ? "&" : "?"
  await page.goto(`${baseUrl}${path}${q}demo=1`, { waitUntil: "networkidle" })
  await page.evaluate(() => document.fonts.ready)
  return { context, page }
}

/** Below 900px the primary action is a second, docked copy of the button. */
function primary(page, name) {
  return page.getByRole("button", { name, exact: true }).filter({ visible: true })
}

/** The Charizard, which carries every state a source row can be in. */
async function pickCharizard(page, label = "Set and number") {
  await page.getByLabel(label).fill("sv151 199")
  await page.getByRole("option").first().waitFor()
  await page.getByRole("option").first().click()
}

for (const mode of MODES) {
  for (const viewport of VIEWPORTS) {
    const tag = `${mode}-${viewport.name}`

    // --- Add stock, with a card chosen and priced --------------------
    {
      const { context, page } = await open(mode, viewport, "/counter/stock/new")
      await page.getByRole("heading", { name: "Add stock" }).waitFor()
      await pickCharizard(page)
      await page.getByTestId("price-sources").waitFor()
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(outDir, `addstock-card-${tag}.png`) })

      await page.getByTestId("price-sources").scrollIntoViewIfNeeded()
      await page.waitForTimeout(250)
      await page.screenshot({ path: join(outDir, `price-sources-${tag}.png`) })

      // The UK comp sheet, which is how a staff figure gets in.
      await page.getByRole("button", { name: "Add UK comp" }).click()
      await page.getByRole("dialog").waitFor()
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(outDir, `uk-comp-${tag}.png`) })
      await context.close()
    }

    // --- Price check on Scan ------------------------------------------
    {
      const { context, page } = await open(mode, viewport, "/counter/scan")
      await page.getByRole("button", { name: "Price check", exact: true }).click()
      const field = page.getByTestId("scan-field")
      await field.fill("sv151 199")
      await field.press("Enter")
      await page.getByTestId("price-check-hit").first().click()
      await page.getByTestId("price-check").waitFor()
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(outDir, `price-check-${tag}.png`) })
      await context.close()
    }

    // --- A buy-in line priced from its sources ------------------------
    {
      const { context, page } = await open(mode, viewport, "/counter/trade/new")
      await page.getByLabel("Find them").fill("Jasmine")
      await page.getByRole("button", { name: /Jasmine Okafor/ }).click()
      await primary(page, "Add items").click()
      await pickCharizard(page)
      const line = page.getByTestId("trade-line").first()
      await line.getByTestId("market-source").waitFor()
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(outDir, `buyin-line-${tag}.png`) })

      await line.getByTestId("market-source").click()
      await line.getByTestId("price-sources").waitFor()
      await line.getByTestId("price-sources").scrollIntoViewIfNeeded()
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(outDir, `buyin-line-sources-${tag}.png`) })
      await context.close()
    }
  }
  console.log(`captured ${mode}`)
}

await browser.close()
console.log(`shots in ${outDir}`)
