/**
 * Screenshots the quote queue, one quote in each state it has a screen for,
 * the item page's hold line and the Settings notifications section, signed
 * in against the demo fixtures, so they can be held against
 * docs/design-references/ and DESIGN.md without a PocketBase.
 *
 *   pnpm --filter web build
 *   pnpm --filter web exec vite preview --port 4173   # in one terminal
 *   node apps/web/scripts/quotes-screens.mjs [baseUrl]
 *
 * Output lands in apps/web/scripts/shots/, which is git-ignored.
 * `screenshots.mjs` covers the kit page and the two reference rebuilds;
 * `screens.mjs`, `customers-trade-screens.mjs`, `pricing-screens.mjs`,
 * `settings-offline-count-screens.mjs` and `portal-screens.mjs` cover the
 * rest.
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

/** The demo item on hold, by the SKU the store seeds it with. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
function ggCode(letter, body) {
  let sum = 0
  const chars = letter + body
  for (let i = 0; i < chars.length; i++) sum += CROCKFORD.indexOf(chars[i]) * (i + 1)
  return `GG${letter}${body}${CROCKFORD[sum % 32]}`
}
const HELD_ITEM = ggCode("S", "R3X9K")

const SCREENS = [
  { name: "queue", path: "/counter/quotes" },
  { name: "quote-new", path: "/counter/quotes/quote_demo_3" },
  { name: "quote-offered", path: "/counter/quotes/quote_demo_1" },
  { name: "quote-accepted", path: "/counter/quotes/quote_demo_4" },
  { name: "hold", path: `/counter/stock/${HELD_ITEM}` },
  { name: "home", path: "/counter" },
]

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
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(outDir, `${name}.png`), fullPage: true })
  console.log(`shot ${name}`)
}

for (const mode of MODES) {
  for (const viewport of VIEWPORTS) {
    for (const screen of SCREENS) {
      const { context, page } = await open(mode, viewport, screen.path)
      await shoot(page, `quotes-${screen.name}-${mode}-${viewport.name}`)
      await context.close()
    }

    // The two states only a sequence reaches: a quote with a line on it
    // ready to be offered, and the cancel sheet.
    {
      const { context, page } = await open(mode, viewport, "/counter/quotes/quote_demo_3")
      await page.getByLabel("Set and number").fill("sv151 199")
      await page.getByRole("option").first().waitFor()
      await page.getByRole("option").first().click()
      await page.getByLabel("Market value for Charizard ex").fill("100")
      await page.getByLabel("With the offer").fill("Bring them in whenever suits.")
      await shoot(page, `quotes-quote-identified-${mode}-${viewport.name}`)
      await context.close()
    }
    {
      const { context, page } = await open(mode, viewport, "/counter/quotes/quote_demo_1")
      await page.getByRole("button", { name: "Cancel this quote" }).click()
      await page.getByRole("dialog").waitFor()
      await shoot(page, `quotes-cancel-sheet-${mode}-${viewport.name}`)
      await context.close()
    }
    // The notifications section, which is the foot of a long page.
    {
      const { context, page } = await open(mode, viewport, "/counter/settings")
      await page.getByRole("heading", { level: 2, name: "Notifications" }).scrollIntoViewIfNeeded()
      await page.waitForTimeout(200)
      await page.screenshot({
        path: join(outDir, `quotes-settings-notifications-${mode}-${viewport.name}.png`),
      })
      console.log(`shot quotes-settings-notifications-${mode}-${viewport.name}`)
      await context.close()
    }
  }
}

await browser.close()
