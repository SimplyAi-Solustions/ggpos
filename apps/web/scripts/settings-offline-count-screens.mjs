/**
 * Screenshots the Phase 3 counter screens, signed in against the demo
 * fixtures: Settings, the offline strip and its conflicts sheet, and a stock
 * count from start to close.
 *
 *   pnpm --filter web build
 *   pnpm --filter web exec vite preview --port 4173   # in one terminal
 *   node apps/web/scripts/settings-offline-count-screens.mjs [baseUrl]
 *
 * Output lands in apps/web/scripts/shots/, which is git-ignored.
 * `screenshots.mjs` covers the kit page and the two reference rebuilds,
 * `screens.mjs` scan, stock, sell, cash and labels, and
 * `customers-trade-screens.mjs` the customers area and the buy-in wizard.
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

/** The demo Charizard and the demo Mabel, at Showcase and Binder A. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
function ggCode(letter, body) {
  let sum = 0
  const chars = letter + body
  for (let i = 0; i < chars.length; i++) sum += CROCKFORD.indexOf(chars[i]) * (i + 1)
  return `GG${letter}${body}${CROCKFORD[sum % 32]}`
}
const SHOWCASE_SKU = ggCode("S", "7F3K2")
const BINDER_SKU = ggCode("S", "T4M9P")

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

async function open(mode, viewport, path, staff = DEMO_STAFF) {
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
    [mode, staff]
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

async function scan(page, code) {
  const field = page.getByTestId("count-scan-field")
  await field.fill(code)
  await field.press("Enter")
}

/** The palette is the one way between screens that works at both widths. */
async function go(page, action) {
  await page.keyboard.press("ControlOrMeta+k")
  const palette = page.getByRole("dialog")
  await palette.waitFor()
  await palette.getByText(action, { exact: true }).click()
  await palette.waitFor({ state: "hidden" })
}

async function goOffline(page) {
  await page.getByRole("button", { name: /Account menu/ }).click()
  await page.getByRole("menuitem", { name: /Simulate offline/ }).click()
}

for (const mode of MODES) {
  for (const viewport of VIEWPORTS) {
    const tag = `${mode}-${viewport.name}`

    // --- Settings, top and bottom -------------------------------------
    {
      const { context, page } = await open(mode, viewport, "/counter/settings")
      await page.getByRole("heading", { name: "Settings" }).waitFor()
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(outDir, `settings-top-${tag}.png`) })

      await page.getByTestId("rules-matrix").scrollIntoViewIfNeeded()
      await page.waitForTimeout(250)
      await page.screenshot({ path: join(outDir, `settings-rules-${tag}.png`) })

      await page.getByTestId("card-sources").scrollIntoViewIfNeeded()
      await page.waitForTimeout(250)
      await page.screenshot({ path: join(outDir, `settings-sources-${tag}.png`) })
      await context.close()
    }

    // --- Settings, staff rather than admin ----------------------------
    {
      const { context, page } = await open(mode, viewport, "/counter/settings", {
        ...DEMO_STAFF,
        role: "staff",
      })
      await page.getByRole("heading", { name: "Settings" }).waitFor()
      await page.waitForTimeout(250)
      await page.screenshot({ path: join(outDir, `settings-staff-${tag}.png`) })
      await context.close()
    }

    // --- A stock count, start to close --------------------------------
    {
      const { context, page } = await open(mode, viewport, "/counter/stock/count")
      await page.getByRole("heading", { name: "Stock count" }).waitFor()
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(outDir, `count-start-${tag}.png`) })

      await page.getByRole("button", { name: "Showcase", exact: true }).click()
      await primary(page, "Start count").click()
      await page.getByTestId("count-scan-field").waitFor()
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(outDir, `count-open-${tag}.png`) })

      await scan(page, SHOWCASE_SKU)
      await page.getByTestId("count-scan-note").waitFor()
      await scan(page, BINDER_SKU)
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(outDir, `count-scanned-${tag}.png`) })

      await primary(page, "Close count").click()
      await page.getByRole("dialog").waitFor()
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(outDir, `count-close-${tag}.png`) })

      await page.getByRole("dialog").getByRole("button", { name: "Close count" }).click()
      await page.getByTestId("count-closed").waitFor()
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(outDir, `count-closed-${tag}.png`) })
      await context.close()
    }

    // --- The offline strip, waiting and refused -----------------------
    {
      const { context, page } = await open(mode, viewport, "/counter/cash")
      await page.getByLabel("Float").fill("100.00")
      await primary(page, "Open session").click()
      await page.getByTestId("cash-expected").waitFor()

      await goOffline(page)
      // Within the tab: the demo stores live in memory, so a fresh page load
      // would close the drawer that was just opened.
      await go(page, "Sell")
      const field = page.getByTestId("sell-scan-field")
      await field.fill(SHOWCASE_SKU)
      await field.press("Enter")
      await page.getByTestId("basket").waitFor()
      await page.getByRole("button", { name: "Cash", exact: true }).click()
      await primary(page, "Mark sold").click()
      await page.getByTestId("sale-done").waitFor()
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(outDir, `offline-queued-${tag}.png`) })
      await context.close()
    }
  }
  console.log(`captured ${mode}`)
}

await browser.close()
console.log(`shots in ${outDir}`)
