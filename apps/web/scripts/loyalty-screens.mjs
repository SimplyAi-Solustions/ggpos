/**
 * Screenshots the Phase 6 counter screens: the Loyalty admin page and each
 * of its sheets, the Guild block on a customer profile, the voucher sheet on
 * Scan, the customer-facing display in all three of its states, the Settings
 * section that switches the display on, and the new-customer form with the
 * referral field.
 *
 *   VITE_DEMO_SWITCH=1 pnpm --filter web build   # the switch honours ?demo=1
 *   pnpm --filter web exec vite preview --port 4173   # in one terminal
 *   node apps/web/scripts/loyalty-screens.mjs [baseUrl]
 *
 * Output lands in apps/web/scripts/shots/, which is git-ignored.
 * `screenshots.mjs` covers the kit page and the two reference rebuilds, and
 * `screens.mjs`, `customers-trade-screens.mjs`, `pricing-screens.mjs`,
 * `quotes-screens.mjs`, `settings-offline-count-screens.mjs` and
 * `portal-screens.mjs` cover the rest.
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

// ---------------------------------------------------------------------------
// The demo shop's codes, built the way packages/shared/src/sku.ts builds them
// (this file is plain JS, so the check character is worked out here rather
// than imported).
// ---------------------------------------------------------------------------
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
function ggCode(letter, body) {
  let sum = 0
  const chars = letter + body
  for (let i = 0; i < chars.length; i++) sum += CROCKFORD.indexOf(chars[i]) * (i + 1)
  return `GG${letter}-${body}${CROCKFORD[sum % 32]}`
}
/** Callum, on the paid Guild Pass, and Jasmine, who holds a voucher. */
const CALLUM = ggCode("C", "T6D1N")
const JASMINE = ggCode("C", "4K7M2")
/** Tom's free sleeve pack, the voucher the counter marks used. */
const FREE_ITEM = ggCode("V", "8P2RT")

// ---------------------------------------------------------------------------
// What the counter has published to the display, seeded straight into the
// key the demo store keeps it under (lib/api/demo/display.ts). The line art
// is the kit's own placeholder card, inline, so nothing has to be fetched.
// ---------------------------------------------------------------------------
const CARD_ART =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 126 176" width="126" height="176">` +
      `<rect x="0.5" y="0.5" width="125" height="175" rx="6" fill="#ffffff" stroke="#0b0b0b" stroke-opacity="0.14"/>` +
      `<rect x="10" y="16" width="106" height="81" fill="#0b0b0b" fill-opacity="0.07"/>` +
      `<rect x="10" y="108" width="76" height="4" fill="#0b0b0b" fill-opacity="0.16"/>` +
      `<rect x="10" y="122" width="49" height="4" fill="#0b0b0b" fill-opacity="0.1"/>` +
      `</svg>`
  )

const IN_FIFTEEN = () => new Date(Date.now() + 15 * 60_000).toISOString()

const SALE_STATE = () => ({
  mode: "sale",
  payload: {
    lines: [
      {
        title: "Charizard ex",
        detail: "Scarlet & Violet 151 · 199/165 · Near mint",
        qty: 1,
        unit_price: 32499,
        image_url: CARD_ART,
      },
      {
        title: "Surging Sparks Elite Trainer Box",
        detail: "Sealed",
        qty: 1,
        unit_price: 4499,
      },
    ],
    subtotal: 36998,
    discount: 225,
    discount_label: "Regular 5% off",
    total: 36773,
    points_to_earn: 3677,
    customer_name: "Jasmine O.",
  },
  token: "tok_shot_sale",
  customer_accepted_at: "",
  expires_at: IN_FIFTEEN(),
})

const BUY_IN_STATE = (accepted = false) => ({
  mode: "buy_in",
  payload: {
    lines: [
      {
        title: "Charizard ex",
        detail: "Scarlet & Violet 151 · 199/165 · Near mint",
        qty: 1,
        offer_price: 19500,
        image_url: CARD_ART,
      },
      { title: "Mario Kart 64, boxed", detail: "N64 · Complete", qty: 1, offer_price: 3000 },
    ],
    total_market: 32499,
    total_offer: 22500,
    payout_type: "credit",
    customer_name: "Jasmine O.",
    credit_bonus_points: 1125,
  },
  token: "tok_shot_buyin",
  customer_accepted_at: accepted ? new Date().toISOString() : "",
  expires_at: IN_FIFTEEN(),
})

mkdirSync(outDir, { recursive: true })

const browser = await chromium
  .launch({ executablePath: "/opt/pw-browsers/chromium" })
  .catch(() => chromium.launch())

/** A page in the demo shop, signed in as the demo admin. */
async function open(mode, viewport, path, display = null) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    colorScheme: mode,
  })
  await context.addInitScript(
    ([theme, staff, state]) => {
      window.sessionStorage.setItem("gg-demo", "1")
      window.localStorage.setItem("theme", theme)
      window.localStorage.setItem("gg-demo-staff", JSON.stringify(staff))
      if (state) window.localStorage.setItem("gg-demo-display", JSON.stringify(state))
      else window.localStorage.removeItem("gg-demo-display")
    },
    [mode, DEMO_STAFF, display]
  )
  const page = await context.newPage()
  await page.goto(`${baseUrl}${path}?demo=1`, { waitUntil: "networkidle" })
  await page.evaluate(() => document.fonts.ready)
  return { context, page }
}

async function shoot(page, name, { fullPage = true } = {}) {
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(outDir, `${name}.png`), fullPage })
  console.log(`shot ${name}`)
}

for (const mode of MODES) {
  for (const viewport of VIEWPORTS) {
    const tag = `${mode}-${viewport.name}`

    // ---- The Loyalty screen, whole ---------------------------------------
    {
      const { context, page } = await open(mode, viewport, "/counter/loyalty")
      await page.getByTestId("points-preview").waitFor()
      await shoot(page, `loyalty-${tag}`)

      // Each editor, in the sheet it opens in.
      await page
        .getByTestId("loyalty-rules")
        .getByRole("button", { name: /Saturday double points/ })
        .click()
      await page.getByRole("dialog").waitFor()
      await shoot(page, `loyalty-rule-sheet-${tag}`, { fullPage: false })
      await page.keyboard.press("Escape")

      await page.getByTestId("loyalty-tiers").getByRole("button").first().click()
      await page.getByRole("dialog").waitFor()
      await shoot(page, `loyalty-tier-sheet-${tag}`, { fullPage: false })
      await page.keyboard.press("Escape")

      await page.getByTestId("loyalty-rewards").getByRole("button").first().click()
      await page.getByRole("dialog").waitFor()
      await shoot(page, `loyalty-reward-sheet-${tag}`, { fullPage: false })
      await page.keyboard.press("Escape")

      await page.getByRole("button", { name: "Record a plan" }).click()
      await page.getByRole("dialog").waitFor()
      await shoot(page, `loyalty-plan-sheet-${tag}`, { fullPage: false })
      await page.keyboard.press("Escape")

      await page.getByRole("button", { name: "Adjust points" }).click()
      await page.getByRole("dialog").waitFor()
      await shoot(page, `loyalty-adjust-sheet-${tag}`, { fullPage: false })
      await context.close()
    }

    // ---- The Guild block on a profile ------------------------------------
    {
      const { context, page } = await open(
        mode,
        viewport,
        `/counter/customers/${CALLUM}`
      )
      await page.getByTestId("guild-section").waitFor()
      await page.getByTestId("guild-section").scrollIntoViewIfNeeded()
      await shoot(page, `guild-section-${tag}`)
      await page.getByRole("button", { name: "Points history" }).click()
      await page.getByRole("dialog").waitFor()
      await shoot(page, `guild-points-history-${tag}`, { fullPage: false })
      await context.close()
    }

    // The other profile: open vouchers and a referral that has been earned.
    {
      const { context, page } = await open(
        mode,
        viewport,
        `/counter/customers/${JASMINE}`
      )
      await page.getByTestId("guild-section").waitFor()
      await page.getByTestId("guild-section").scrollIntoViewIfNeeded()
      await shoot(page, `guild-vouchers-${tag}`)
      await context.close()
    }

    // ---- A scanned voucher ------------------------------------------------
    {
      const { context, page } = await open(mode, viewport, "/counter/scan")
      const field = page.getByTestId("scan-field")
      await field.fill(FREE_ITEM)
      await field.press("Enter")
      await page.getByTestId("voucher-sheet").waitFor()
      await shoot(page, `scan-voucher-${tag}`, { fullPage: false })
      await context.close()
    }

    // ---- The customer-facing display -------------------------------------
    for (const [name, state] of [
      ["display-idle", null],
      ["display-sale", SALE_STATE()],
      ["display-buyin", BUY_IN_STATE()],
      ["display-accepted", BUY_IN_STATE(true)],
    ]) {
      const { context, page } = await open(mode, viewport, "/display", state)
      await page.waitForTimeout(300)
      await shoot(page, `${name}-${tag}`)
      await context.close()
    }

    // ---- Settings: the section that switches it on ------------------------
    {
      const { context, page } = await open(mode, viewport, "/counter/settings")
      await page
        .getByRole("heading", { level: 2, name: "Customer display" })
        .scrollIntoViewIfNeeded()
      await page.waitForTimeout(200)
      await shoot(page, `settings-display-${tag}`, { fullPage: false })
      await context.close()
    }

    // ---- The new-customer form, with the referral field -------------------
    {
      const { context, page } = await open(mode, viewport, "/counter/customers/new")
      await page.getByLabel("Referred by").fill("GGC-4K7M2S")
      await shoot(page, `new-customer-referral-${tag}`)
      await context.close()
    }
  }
}

await browser.close()
