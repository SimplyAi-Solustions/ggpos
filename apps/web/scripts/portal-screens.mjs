/**
 * Screenshots My Vault and the public estimate, signed in against the demo
 * fixtures, so every portal screen can be held against DESIGN.md and
 * docs/design-references/ without a PocketBase.
 *
 *   pnpm --filter web build
 *   pnpm --filter web exec vite preview --port 4173   # in one terminal
 *   node apps/web/scripts/portal-screens.mjs [baseUrl]
 *
 * Output lands in apps/web/scripts/shots/, which is git-ignored.
 * `screenshots.mjs` covers the kit page and the two reference rebuilds;
 * `screens.mjs`, `customers-trade-screens.mjs`, `pricing-screens.mjs` and
 * `settings-offline-count-screens.mjs` cover the counter.
 */
import { chromium } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "shots")
const photo = join(here, "..", "..", "..", "e2e", "fixtures", "id-sample.png")
const baseUrl = (process.argv[2] ?? "http://127.0.0.1:4173").replace(/\/$/, "")

const VIEWPORTS = [
  { name: "1440x1200", width: 1440, height: 1200 },
  { name: "390x844", width: 390, height: 844 },
]
const MODES = ["light", "dark"]

/** The demo portal customer, the same record the counter's demo book holds. */
const DEMO_CUSTOMER_ID = "cust_demo_1"
const DEMO_QR_TOKEN = "demo-4k7m2-token"

const SCREENS = [
  { name: "card", path: "/account" },
  { name: "quotes", path: "/account/quotes" },
  { name: "quote", path: "/account/quotes/quote_demo_1" },
  { name: "quote-new", path: "/account/quotes/new" },
  { name: "wants", path: "/account/wants" },
  { name: "credit", path: "/account/credit" },
  { name: "trade-ins", path: "/account/trade-ins" },
  { name: "trade-in", path: "/account/trade-ins/trade_demo_portal" },
  { name: "profile", path: "/account/me" },
  { name: "notifications", path: "/account/notifications" },
  { name: "estimate", path: "/account/estimate" },
]

/** The signed-out screens, which must never carry a session. */
const PUBLIC_SCREENS = [
  { name: "signin", path: "/account" },
  { name: "estimate-public", path: "/estimate" },
  { name: "card-landing", path: `/c/${DEMO_QR_TOKEN}` },
]

mkdirSync(outDir, { recursive: true })

const browser = await chromium
  .launch({ executablePath: "/opt/pw-browsers/chromium" })
  .catch(() => chromium.launch())

async function open(mode, viewport, path, { signedIn }) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    colorScheme: mode,
  })
  await context.addInitScript(
    ([theme, customerId]) => {
      window.sessionStorage.setItem("gg-demo", "1")
      window.localStorage.setItem("theme", theme)
      if (customerId) {
        window.localStorage.setItem("gg-demo-customer", customerId)
      } else {
        window.localStorage.removeItem("gg-demo-customer")
      }
    },
    [mode, signedIn ? DEMO_CUSTOMER_ID : ""]
  )
  const page = await context.newPage()
  const q = path.includes("?") ? "&" : "?"
  await page.goto(`${baseUrl}${path}${q}demo=1`, { waitUntil: "networkidle" })
  await page.evaluate(() => document.fonts.ready)
  return { context, page }
}

async function shoot(page, name) {
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(outDir, `${name}.png`) })
}

for (const mode of MODES) {
  for (const viewport of VIEWPORTS) {
    for (const screen of SCREENS) {
      const { context, page } = await open(mode, viewport, screen.path, {
        signedIn: true,
      })
      // The estimate is empty until a card is picked, so pick one.
      if (screen.name === "estimate") {
        await page.getByLabel("Card").fill("Charizard")
        await page.getByRole("option", { name: /Charizard ex/ }).click()
      }
      await shoot(page, `portal-${screen.name}-${mode}-${viewport.name}`)
      await context.close()
    }

    for (const screen of PUBLIC_SCREENS) {
      const { context, page } = await open(mode, viewport, screen.path, {
        signedIn: false,
      })
      if (screen.name === "estimate-public") {
        await page.getByLabel("Card").fill("Charizard")
        await page.getByRole("option", { name: /Charizard ex/ }).click()
      }
      await shoot(page, `portal-${screen.name}-${mode}-${viewport.name}`)
      await context.close()
    }

    // The two states only a sequence reaches: the code step, and a quote
    // form with photos on it.
    {
      const { context, page } = await open(mode, viewport, "/account", {
        signedIn: false,
      })
      await page.getByRole("button", { name: "Send me a code" }).click()
      await page.getByLabel("Code", { exact: true }).fill("48213976")
      await shoot(page, `portal-signin-code-${mode}-${viewport.name}`)
      await context.close()
    }
    {
      const { context, page } = await open(mode, viewport, "/account/quotes/new", {
        signedIn: true,
      })
      await page.getByTestId("quote-photo-input").setInputFiles([photo, photo, photo])
      await page.getByLabel("Message").fill("Four holos and a boxed SNES game.")
      await shoot(page, `portal-quote-new-filled-${mode}-${viewport.name}`)
      await context.close()
    }
    // The two sheets on the profile screen.
    for (const [name, button] of [
      ["privacy", "How we use your data"],
      ["delete", "Delete my account"],
    ]) {
      const { context, page } = await open(mode, viewport, "/account/me", {
        signedIn: true,
      })
      await page.getByRole("button", { name: button }).first().click()
      await shoot(page, `portal-profile-${name}-${mode}-${viewport.name}`)
      await context.close()
    }
  }
}

await browser.close()
console.log(`Wrote portal screens to ${outDir}`)
