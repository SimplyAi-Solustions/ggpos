/**
 * Screenshots the till (DESIGN.md, section 10) in the states it is judged
 * in: empty, a ticket of five mixed lines with a customer, the cash step,
 * the card step and done, at the tablet's 1180x820, the Mac's 1440x900 and
 * a phone's 390x844, in both colour modes.
 *
 *   VITE_DEMO_SWITCH=1 pnpm --filter web build        # honours ?demo=1
 *   pnpm --filter web exec vite preview --port 4181    # in one terminal
 *   node apps/web/scripts/till-screens.mjs [baseUrl]
 *
 * Output lands in apps/web/scripts/shots/, which is git-ignored.
 */
import { chromium } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "shots")
const baseUrl = (process.argv[2] ?? "http://127.0.0.1:4181").replace(/\/$/, "")

const VIEWPORTS = [
  { name: "1180x820", width: 1180, height: 820 },
  { name: "1440x900", width: 1440, height: 900 },
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

// Codes built the way packages/shared/src/sku.ts builds them (this file is
// plain JS, so the check character is worked out here).
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
function ggCode(letter, body) {
  let sum = 0
  const chars = letter + body
  for (let i = 0; i < chars.length; i++) sum += CROCKFORD.indexOf(chars[i]) * (i + 1)
  return `GG${letter}-${body}${CROCKFORD[sum % 32]}`
}
const CHARIZARD = ggCode("S", "7F3K2")
const MABEL = ggCode("S", "T4M9P")
const JASMINE = ggCode("C", "4K7M2")

mkdirSync(outDir, { recursive: true })

const browser = await chromium
  .launch({ executablePath: "/opt/pw-browsers/chromium" })
  .catch(() => chromium.launch())

async function open(mode, viewport) {
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
  await page.goto(`${baseUrl}/counter/till?demo=1`, { waitUntil: "networkidle" })
  await page.evaluate(() => document.fonts.ready)
  await page.getByTestId("till").waitFor()
  return { context, page }
}

async function shoot(page, name) {
  await page.waitForTimeout(450)
  await page.screenshot({ path: join(outDir, `${name}.png`) })
  console.log(`shot ${name}`)
}

async function scan(page, code) {
  // The counter's wedge listener takes a scan wherever the focus is; the
  // till's own field commits on Enter at any speed.
  const field = page.getByTestId("till-scan-field")
  if (await field.isVisible()) {
    await field.fill(code)
    await field.press("Enter")
  } else {
    await page.keyboard.type(code, { delay: 5 })
    await page.keyboard.press("Enter")
  }
}

async function tile(page, name) {
  await page.getByTestId("till-tile").filter({ hasText: name }).first().click()
}

/** Five mixed lines and a customer: two singles, a stock line of two, a service and a keyed price. */
async function buildTicket(page) {
  await scan(page, JASMINE)
  await page.getByText(/Jasmine Okafor attached/).waitFor()
  await scan(page, CHARIZARD)
  await page.getByText("Charizard ex added").waitFor()
  await scan(page, MABEL)
  await page.getByText(/Mabel, Heir to Cragflame added/).waitFor()
  await tile(page, "Prismatic booster")
  await tile(page, "Prismatic booster")
  await tile(page, "Table time")
  await tile(page, "Single card")
  await page.getByTestId("key-price-sheet").waitFor()
  await page.keyboard.type("250")
  await page.getByLabel("What it is").fill("Pikachu, Base Set")
  await page.getByTestId("key-price-add").click()
  await page.getByTestId("key-price-sheet").waitFor({ state: "hidden" })
}

async function pay(page) {
  await page.getByTestId("till-pay").filter({ visible: true }).click()
  await page.getByTestId("till-to-pay").waitFor()
}

for (const mode of MODES) {
  for (const viewport of VIEWPORTS) {
    const tag = `${mode}-${viewport.name}`
    const phone = viewport.width < 900

    {
      const { context, page } = await open(mode, viewport)
      await page.getByTestId("till-tiles").waitFor()
      await shoot(page, `till-empty-${tag}`)

      await buildTicket(page)
      if (phone) await page.getByTestId("till-ticket-tab").click()
      await shoot(page, `till-ticket-${tag}`)

      await pay(page)
      await page.getByRole("button", { name: "Cash", exact: true }).click()
      await page.getByTestId("till-cash-step").waitFor()
      await shoot(page, `till-cash-${tag}`)

      await page.getByRole("button", { name: "Card", exact: true }).click()
      await page.getByTestId("till-card-step").waitFor()
      await shoot(page, `till-card-${tag}`)

      // Done, with change: £400 handed over in cash.
      await page.getByRole("button", { name: "Cash", exact: true }).click()
      await page.getByTestId("till-cash-step").waitFor()
      await page.keyboard.type("40000")
      await page.getByTestId("till-take-cash").click()
      await page.getByTestId("till-done").waitFor()
      await shoot(page, `till-done-${tag}`)
      await context.close()
    }
  }
}

await browser.close()
