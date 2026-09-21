/**
 * The before-and-after set for the Phase 7 polish pass: every route the pass
 * touches, in both colour modes at both of the widths DESIGN.md is judged
 * at, written to its own folder so the two sets can be held side by side.
 *
 *   VITE_DEMO_SWITCH=1 pnpm --filter web build   # the switch honours ?demo=1
 *   pnpm --filter web exec vite preview --port 4293   # in one terminal
 *   node apps/web/scripts/polish-screens.mjs before [baseUrl]
 *   ...make the changes, rebuild...
 *   node apps/web/scripts/polish-screens.mjs after [baseUrl]
 *
 * Output lands in apps/web/scripts/shots/polish-<set>/, which is git-ignored.
 * The other `*-screens.mjs` scripts stay as they are: this one crosses every
 * area at once so one pass can compare them, rather than replacing them.
 *
 * `only=<substring>` as a third argument narrows the run to the screens whose
 * name contains it, which is how a single screen is re-shot after a fix.
 */
import { chromium } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const set = (process.argv[2] ?? "before").replace(/[^a-z0-9-]/gi, "")
const baseUrl = (process.argv[3] ?? "http://127.0.0.1:4293").replace(/\/$/, "")
const only = (process.argv[4] ?? "").replace(/^only=/, "")
const outDir = join(here, "shots", `polish-${set}`)

const VIEWPORTS = [
  { name: "1440x1200", width: 1440, height: 1200 },
  { name: "390x844", width: 390, height: 844 },
]
const MODES = ["light", "dark"]

/** The demo codes, built the way packages/shared/src/sku.ts builds them. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
function ggCode(letter, body) {
  let sum = 0
  const chars = letter + body
  for (let i = 0; i < chars.length; i++) sum += CROCKFORD.indexOf(chars[i]) * (i + 1)
  return `GG${letter}${body}${CROCKFORD[sum % 32]}`
}
const DEMO_SKU = ggCode("S", "7F3K2")
const CUSTOMER = ggCode("C", "4K7M2")
const DEMO_CUSTOMER_ID = "cust_demo_1"
const DEMO_QR_TOKEN = "demo-4k7m2-token"

/** The same shape lib/auth.ts persists, so the counter guard lets us in. */
const DEMO_STAFF = {
  id: "staff_demo",
  email: "demo@ggentertainment.co.uk",
  name: "Demo Counter",
  role: "admin",
  active: true,
}

/** What the counter has published to the customer-facing display. */
const DISPLAY_SALE = {
  mode: "sale",
  payload: {
    lines: [
      {
        title: "Charizard ex",
        detail: "Scarlet & Violet 151 · 199/165 · Near mint",
        qty: 1,
        unit_price: 32499,
      },
      { title: "Surging Sparks Elite Trainer Box", detail: "Sealed", qty: 1, unit_price: 4499 },
    ],
    subtotal: 36998,
    discount: 225,
    discount_label: "Regular 5% off",
    total: 36773,
    points_to_earn: 3677,
    customer_name: "Jasmine O.",
  },
  token: "tok_polish_sale",
  customer_accepted_at: "",
  expires_at: new Date(Date.now() + 900000).toISOString(),
}

const DISPLAY_BUY_IN = {
  mode: "buy_in",
  payload: {
    lines: [
      {
        title: "Charizard ex",
        detail: "Scarlet & Violet 151 · 199/165 · Near mint",
        qty: 1,
        offer_price: 19500,
      },
      { title: "Mario Kart 64, boxed", detail: "N64 · Complete", qty: 1, offer_price: 3000 },
    ],
    total_market: 32499,
    total_offer: 22500,
    payout_type: "credit",
    customer_name: "Jasmine O.",
    credit_bonus_points: 1125,
  },
  token: "tok_polish_buyin",
  customer_accepted_at: "",
  expires_at: new Date(Date.now() + 900000).toISOString(),
}

const primary = (page, name) =>
  page.getByRole("button", { name, exact: true }).filter({ visible: true })

/**
 * Drives the buy-in wizard as far as `stop`, which is how the steps a static
 * URL cannot reach get photographed: the demo stores live in memory per tab.
 */
function buyIn(stop) {
  return async (page) => {
    await page.getByLabel("Find them").fill("Jasmine")
    await page.getByRole("button", { name: /Jasmine Okafor/ }).first().click()
    if (stop === "customer") return
    await primary(page, "Add items").click()
    if (stop === "items-empty") return
    await page.getByLabel("Set and number").fill("sv151 199")
    await page.getByRole("option").first().waitFor()
    await page.getByRole("option").first().click()
    await page.getByLabel("Market value for Charizard ex").fill("100")
    if (stop === "items") return
    await primary(page, "Make the offer").click()
    if (stop === "offer") return
    await page.getByTestId("tile-credit").click()
    if (stop === "payout") return
  }
}

/** Every screen the pass covers, in the order the brief takes them. */
const SCREENS = [
  // ---- My Vault, the public pages and sign-in --------------------------
  { name: "portal-card", path: "/account", as: "customer" },
  { name: "portal-quotes", path: "/account/quotes", as: "customer" },
  { name: "portal-quote", path: "/account/quotes/quote_demo_1", as: "customer" },
  { name: "portal-quote-new", path: "/account/quotes/new", as: "customer" },
  { name: "portal-wants", path: "/account/wants", as: "customer" },
  { name: "portal-credit", path: "/account/credit", as: "customer" },
  { name: "portal-trade-ins", path: "/account/trade-ins", as: "customer" },
  { name: "portal-trade-in", path: "/account/trade-ins/trade_demo_portal", as: "customer" },
  { name: "portal-guild", path: "/account/guild", as: "customer" },
  { name: "portal-rewards", path: "/account/rewards", as: "customer" },
  { name: "portal-reward", path: "/account/rewards/reward_booster", as: "customer" },
  { name: "portal-points", path: "/account/points", as: "customer" },
  { name: "portal-me", path: "/account/me", as: "customer" },
  { name: "portal-notifications", path: "/account/notifications", as: "customer" },
  { name: "portal-estimate", path: "/account/estimate", as: "customer" },
  { name: "portal-signin", path: "/account", as: "nobody" },
  { name: "public-card", path: `/c/${DEMO_QR_TOKEN}`, as: "nobody" },
  { name: "public-estimate", path: "/estimate", as: "nobody" },
  { name: "login", path: "/login", as: "nobody" },

  // ---- The customer-facing display -------------------------------------
  { name: "display-idle", path: "/display" },
  { name: "display-sale", path: "/display", display: DISPLAY_SALE },
  { name: "display-buyin", path: "/display", display: DISPLAY_BUY_IN },

  // ---- The counter -----------------------------------------------------
  { name: "counter-home", path: "/counter" },
  { name: "counter-scan", path: "/counter/scan" },
  { name: "counter-stock", path: "/counter/stock" },
  { name: "counter-item", path: `/counter/stock/${DEMO_SKU}` },
  { name: "counter-stock-new", path: "/counter/stock/new" },
  { name: "counter-stock-count", path: "/counter/stock/count" },
  { name: "counter-trade", path: "/counter/trade" },
  { name: "counter-trade-receipt", path: "/counter/trade/trade_demo_1/receipt" },
  { name: "buyin-customer", path: "/counter/trade/new" },
  { name: "buyin-items-empty", path: "/counter/trade/new", prepare: buyIn("items-empty") },
  { name: "buyin-items", path: "/counter/trade/new", prepare: buyIn("items") },
  { name: "buyin-offer", path: "/counter/trade/new", prepare: buyIn("offer") },
  { name: "buyin-payout", path: "/counter/trade/new", prepare: buyIn("payout") },
  { name: "counter-customers", path: "/counter/customers" },
  { name: "counter-customer-new", path: "/counter/customers/new" },
  { name: "counter-customer", path: `/counter/customers/${CUSTOMER}` },
  { name: "counter-customer-card", path: `/counter/customers/${CUSTOMER}/card` },
  { name: "counter-loyalty", path: "/counter/loyalty" },
  { name: "counter-quotes", path: "/counter/quotes" },
  { name: "counter-quote", path: "/counter/quotes/quote_demo_1" },
  { name: "counter-reports", path: "/counter/reports" },
  { name: "report-sales", path: "/counter/reports/sales" },
  { name: "report-buyins", path: "/counter/reports/buyins" },
  { name: "report-margin", path: "/counter/reports/margin" },
  { name: "report-stock", path: "/counter/reports/stock" },
  { name: "report-channels", path: "/counter/reports/channels" },
  { name: "report-customers", path: "/counter/reports/customers" },
  { name: "report-loyalty", path: "/counter/reports/loyalty" },
  { name: "report-cash", path: "/counter/reports/cash" },
  { name: "report-compliance", path: "/counter/reports/compliance" },
  { name: "counter-exports", path: "/counter/exports" },
  { name: "kit", path: "/kit", as: "nobody" },

  // ---- The screens Phase 7 shipped -------------------------------------
  { name: "counter-sell", path: "/counter/sell" },
  {
    name: "counter-sell-basket",
    path: "/counter/sell",
    async prepare(page) {
      const field = page.getByTestId("sell-scan-field")
      await field.fill(DEMO_SKU)
      await field.press("Enter")
      await page.getByTestId("basket").waitFor()
    },
  },
  { name: "counter-labels", path: "/counter/labels" },
  { name: "counter-cash", path: "/counter/cash" },
  { name: "counter-settings", path: "/counter/settings" },
  {
    name: "shortcut-overlay",
    path: "/counter",
    fullPage: false,
    async prepare(page) {
      await page.keyboard.press("?")
      await page.getByRole("dialog").waitFor()
    },
  },
]

mkdirSync(outDir, { recursive: true })

// The remote build environment ships one Chromium at this path; a machine
// with Playwright's own download falls through to it.
const browser = await chromium
  .launch({ executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium" })
  .catch(() => chromium.launch())

const chosen = SCREENS.filter((screen) => !only || screen.name.includes(only))
let shot = 0

for (const mode of MODES) {
  for (const viewport of VIEWPORTS) {
    for (const screen of chosen) {
      const as = screen.as ?? "staff"
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        colorScheme: mode,
      })
      await context.addInitScript(
        ([theme, staff, customer, display]) => {
          window.sessionStorage.setItem("gg-demo", "1")
          window.localStorage.setItem("theme", theme)
          if (staff) window.localStorage.setItem("gg-demo-staff", JSON.stringify(staff))
          else window.localStorage.removeItem("gg-demo-staff")
          if (customer) window.localStorage.setItem("gg-demo-customer", customer)
          else window.localStorage.removeItem("gg-demo-customer")
          if (display) window.localStorage.setItem("gg-demo-display", JSON.stringify(display))
          else window.localStorage.removeItem("gg-demo-display")
        },
        [
          mode,
          as === "staff" ? DEMO_STAFF : null,
          as === "customer" ? DEMO_CUSTOMER_ID : null,
          screen.display ?? null,
        ]
      )
      const page = await context.newPage()
      const q = screen.path.includes("?") ? "&" : "?"
      await page.goto(`${baseUrl}${screen.path}${q}demo=1`, { waitUntil: "networkidle" })
      await page.evaluate(() => document.fonts.ready)
      let failed = ""
      if (screen.prepare) {
        try {
          await screen.prepare(page)
        } catch (error) {
          // A step that did not run leaves the screen in a state nobody asked
          // for, and a shot of it would look plausible in the folder. Name the
          // file for what happened so a broken step cannot pass for an after.
          failed = "-PREPARE-FAILED"
          console.error(`  ${screen.name}: ${String(error).split("\n")[0]}`)
        }
      }
      // Long enough for the page rise and the row stagger to have settled.
      await page.waitForTimeout(500)
      await page.screenshot({
        path: join(outDir, `${screen.name}${failed}-${mode}-${viewport.name}.png`),
        fullPage: screen.fullPage !== false,
      })
      shot += 1
      await context.close()
    }
    console.log(`${mode} ${viewport.name}: ${chosen.length} screens`)
  }
}

await browser.close()
console.log(`${shot} shots in ${outDir}`)
