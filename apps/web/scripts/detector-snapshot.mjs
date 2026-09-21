/**
 * Saves each signed-in counter route as a self-contained HTML file, so the
 * Impeccable detector can scan pages that live behind the demo sign-in.
 *
 *   VITE_DEMO_SWITCH=1 pnpm --filter web build   # the switch honours ?demo=1
 *   pnpm --filter web exec vite preview --port 4173      # in one terminal
 *   node apps/web/scripts/detector-snapshot.mjs <outDir> [baseUrl] [w] [h]
 *   IMPECCABLE_BROWSER=/path/to/chromium \
 *     .claude/skills/impeccable/scripts/bin/linux-x64/impeccable detect <outDir>
 *
 * Note on reading the results: in file mode the detector's `cramped-padding`
 * rule only sees padding written as an inline style, so every Tailwind
 * `py-*` / `pt-*` class reads as zero inset and the rule fires on rows that
 * are correctly spaced. Proved by copying one snapshot and moving the same
 * padding into inline styles: 7 findings became 0 with no other change. A
 * live URL scan does not have this problem, but the bundled Chromium refuses
 * to launch as root and takes no --no-sandbox flag.
 */
import { chromium } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const outDir = process.argv[2]
const baseUrl = process.argv[3] ?? "http://127.0.0.1:4173"
const width = Number(process.argv[4] ?? 1440)
const height = Number(process.argv[5] ?? 1200)

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
function ggCode(letter, body) {
  let sum = 0
  const chars = letter + body
  for (let i = 0; i < chars.length; i++) sum += CROCKFORD.indexOf(chars[i]) * (i + 1)
  return `GG${letter}${body}${CROCKFORD[sum % 32]}`
}
const CUSTOMER = ggCode("C", "4K7M2")
/** Callum, who is on the paid Guild Pass, and Tom's free-item voucher. */
const GUILD_CUSTOMER = ggCode("C", "T6D1N")
const VOUCHER = ggCode("V", "8P2RT")

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
  token: "tok_snapshot_sale",
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
  token: "tok_snapshot_buyin",
  customer_accepted_at: "",
  expires_at: new Date(Date.now() + 900000).toISOString(),
}

const DEMO_STAFF = {
  id: "staff_demo",
  email: "demo@ggentertainment.co.uk",
  name: "Demo Counter",
  role: "admin",
  active: true,
}

const ROUTES = [
  ["customers", "/counter/customers"],
  ["customer-profile", `/counter/customers/${CUSTOMER}`],
  ["customer-new", "/counter/customers/new"],
  ["customer-card", `/counter/customers/${CUSTOMER}/card`],
  ["trade", "/counter/trade"],
  ["buyin-new", "/counter/trade/new"],
  // Phase 3: settings, stock counts and the offline strip.
  ["settings", "/counter/settings"],
  ["stock-count", "/counter/stock/count"],
  // Phase 5: the quote queue and a quote in each state it has a screen for.
  ["quotes", "/counter/quotes"],
  ["quote-new", "/counter/quotes/quote_demo_3"],
  ["quote-offered", "/counter/quotes/quote_demo_1"],
  ["quote-accepted", "/counter/quotes/quote_demo_4"],
  // Phase 6: the Guild admin screen, the Guild block on a profile, and the
  // customer-facing display with nothing on it.
  ["loyalty", "/counter/loyalty"],
  ["guild-profile", `/counter/customers/${GUILD_CUSTOMER}`],
  ["display-idle", "/display"],
]

mkdirSync(outDir, { recursive: true })
const browser = await chromium
  .launch({ executablePath: "/opt/pw-browsers/chromium" })
  .catch(() => chromium.launch())

async function snap(name, path, drive) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: "light",
  })
  await context.addInitScript(
    ([staff]) => {
      window.sessionStorage.setItem("gg-demo", "1")
      window.localStorage.setItem("theme", "light")
      window.localStorage.setItem("gg-demo-staff", JSON.stringify(staff))
    },
    [DEMO_STAFF]
  )
  const page = await context.newPage()
  await page.goto(`${baseUrl}${path}?demo=1`, { waitUntil: "networkidle" })
  await page.evaluate(() => document.fonts.ready)
  if (drive) await drive(page)
  await page.waitForTimeout(400)

  const html = await page.evaluate(async () => {
    for (const link of Array.from(
      document.querySelectorAll('link[rel="stylesheet"]')
    )) {
      const css = await fetch(link.href).then((r) => r.text())
      const style = document.createElement("style")
      style.textContent = css
      link.replaceWith(style)
    }
    for (const script of Array.from(document.querySelectorAll("script"))) {
      script.remove()
    }
    return `<!doctype html>\n${document.documentElement.outerHTML}`
  })
  writeFileSync(join(outDir, `${name}.html`), html)
  await context.close()
  console.log(`snapped ${name}`)
}

function primary(page, name) {
  return page.getByRole("button", { name, exact: true }).filter({ visible: true })
}

for (const [name, path] of ROUTES) await snap(name, path)

await snap("buyin-items", "/counter/trade/new", async (page) => {
  await page.getByLabel("Find them").fill("Jasmine")
  await page.getByRole("button", { name: /Jasmine Okafor/ }).click()
  await primary(page, "Add items").click()
  await page.getByLabel("Set and number").fill("sv151 199")
  await page.getByRole("option").first().waitFor()
  await page.getByRole("option").first().click()
  await page.getByLabel("Market value for Charizard ex").fill("100")
  await page.getByRole("button", { name: "Sealed", exact: true }).click()
  await page.getByLabel("Title").fill("Surging Sparks Elite Trainer Box")
  await page.getByRole("button", { name: "Add line" }).click()
})

await snap("buyin-offer", "/counter/trade/new", async (page) => {
  await page.getByLabel("Find them").fill("Jasmine")
  await page.getByRole("button", { name: /Jasmine Okafor/ }).click()
  await primary(page, "Add items").click()
  await page.getByLabel("Set and number").fill("sv151 199")
  await page.getByRole("option").first().waitFor()
  await page.getByRole("option").first().click()
  await page.getByLabel("Market value for Charizard ex").fill("100")
  await primary(page, "Make the offer").click()
  await page.getByTestId("tile-cash").click()
})

await snap("buyin-id", "/counter/trade/new", async (page) => {
  await page.getByLabel("Find them").fill("Tom")
  await page.getByRole("button", { name: /Tom Bradbury/ }).first().click()
  await primary(page, "Add items").click()
  await page.getByLabel("Set and number").fill("sv151 205")
  await page.getByRole("option").first().waitFor()
  await page.getByRole("option").first().click()
  await page.getByLabel("Market value for Mew ex").fill("60")
  await primary(page, "Make the offer").click()
  await page.getByTestId("tile-cash").click()
  await page
    .getByRole("switch", {
      name: "The customer has heard the terms and agrees to them",
    })
    .click()
  const pad = page.getByTestId("signature-pad")
  await pad.evaluate((el) => el.scrollIntoView({ block: "center" }))
  await page.waitForTimeout(200)
  const box = await pad.boundingBox()
  await page.mouse.move(box.x + 20, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3, { steps: 6 })
  await page.mouse.up()
  await primary(page, "Check ID").click()
  await page.getByTestId("id-photo-input").waitFor()
})

await snap("buyin-done", "/counter/trade/new", async (page) => {
  await page.getByLabel("Find them").fill("Jasmine")
  await page.getByRole("button", { name: /Jasmine Okafor/ }).click()
  await primary(page, "Add items").click()
  await page.getByLabel("Set and number").fill("sv151 199")
  await page.getByRole("option").first().waitFor()
  await page.getByRole("option").first().click()
  await page.getByLabel("Market value for Charizard ex").fill("100")
  await primary(page, "Make the offer").click()
  await page.getByTestId("tile-credit").click()
  await page
    .getByRole("switch", {
      name: "The customer has heard the terms and agrees to them",
    })
    .click()
  const pad = page.getByTestId("signature-pad")
  await pad.evaluate((el) => el.scrollIntoView({ block: "center" }))
  await page.waitForTimeout(200)
  const box = await pad.boundingBox()
  await page.mouse.move(box.x + 20, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3, { steps: 6 })
  await page.mouse.up()
  await primary(page, "Complete buy-in").click()
  await page.getByRole("heading", { name: "Bought in" }).waitFor()
})

await snap("buyin-receipt", "/counter/trade/trade_demo_1/receipt")

// --- Phase 3: the states a static URL cannot reach ------------------------

const SKU = ggCode("S", "7F3K2")

await snap("count-open", "/counter/stock/count", async (page) => {
  await page.getByRole("button", { name: "Showcase", exact: true }).click()
  await primary(page, "Start count").click()
  await page.getByTestId("count-scan-field").waitFor()
  const field = page.getByTestId("count-scan-field")
  await field.fill(SKU)
  await field.press("Enter")
  await page.getByTestId("count-scan-note").waitFor()
  await field.fill(ggCode("S", "T4M9P"))
  await field.press("Enter")
  await page.getByTestId("extra-lines").waitFor()
})

await snap("offline-strip", "/counter/sell", async (page) => {
  await page.getByRole("button", { name: /Account menu/ }).click()
  await page.getByRole("menuitem", { name: /Simulate offline/ }).click()
  const field = page.getByTestId("sell-scan-field")
  await field.fill(SKU)
  await field.press("Enter")
  await page.getByTestId("basket").waitFor()
  await page.getByTestId("offline-strip").waitFor()
})

// Phase 6: the voucher sheet a scanned reward code opens, and the display
// with a basket and with an offer on it.
await snap("scan-voucher", "/counter/scan", async (page) => {
  const field = page.getByTestId("scan-field")
  await field.fill(VOUCHER)
  await field.press("Enter")
  await page.getByTestId("voucher-sheet").waitFor()
})

for (const [name, state] of [
  ["display-sale", DISPLAY_SALE],
  ["display-buyin", DISPLAY_BUY_IN],
]) {
  await snap(name, "/display", async (page) => {
    await page.evaluate((published) => {
      window.localStorage.setItem("gg-demo-display", JSON.stringify(published))
    }, state)
    await page.reload({ waitUntil: "networkidle" })
    await page.waitForTimeout(300)
  })
}

await browser.close()
