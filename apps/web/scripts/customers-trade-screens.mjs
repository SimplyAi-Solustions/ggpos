/**
 * Screenshots the customers area and every step of the buy-in wizard, signed
 * in against the demo fixtures, so they can be held against
 * docs/design-references/ and DESIGN.md without a PocketBase.
 *
 *   pnpm --filter web build
 *   pnpm --filter web exec vite preview --port 4173   # in one terminal
 *   node apps/web/scripts/customers-trade-screens.mjs [baseUrl]
 *
 * Output lands in apps/web/scripts/shots/, which is git-ignored.
 * `screenshots.mjs` covers the kit page and the two reference rebuilds;
 * `screens.mjs` covers scan, stock, sell, cash and labels.
 */
import { chromium } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "shots")
const idPhoto = join(here, "..", "..", "..", "e2e", "fixtures", "id-sample.png")
const baseUrl = (process.argv[2] ?? "http://127.0.0.1:4173").replace(/\/$/, "")

const VIEWPORTS = [
  { name: "1440x1200", width: 1440, height: 1200 },
  { name: "390x844", width: 390, height: 844 },
]
const MODES = ["light", "dark"]

/**
 * The demo customers' codes, built here rather than imported so this stays a
 * plain Node module: the check character is the weighted mod-32 from
 * packages/shared/src/sku.ts.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
function ggCode(letter, body) {
  let sum = 0
  const chars = letter + body
  for (let i = 0; i < chars.length; i++) sum += CROCKFORD.indexOf(chars[i]) * (i + 1)
  return `GG${letter}${body}${CROCKFORD[sum % 32]}`
}
const VERIFIED_CUSTOMER = ggCode("C", "4K7M2") // Jasmine Okafor, ID verified

/** The same shape lib/auth.ts persists, so the guard lets us straight in. */
const DEMO_STAFF = {
  id: "staff_demo",
  email: "demo@ggentertainment.co.uk",
  name: "Demo Counter",
  role: "admin",
  active: true,
}

const SCREENS = [
  { name: "customers", path: "/counter/customers" },
  { name: "customer-profile", path: `/counter/customers/${VERIFIED_CUSTOMER}` },
  { name: "customer-new", path: "/counter/customers/new" },
  { name: "customer-card", path: `/counter/customers/${VERIFIED_CUSTOMER}/card` },
  { name: "trade", path: "/counter/trade" },
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
  const q = path.includes("?") ? "&" : "?"
  await page.goto(`${baseUrl}${path}${q}demo=1`, { waitUntil: "networkidle" })
  await page.evaluate(() => document.fonts.ready)
  return { context, page }
}

/** Below 900px the primary action is a second, docked copy of the button. */
function primary(page, name) {
  return page.getByRole("button", { name, exact: true }).filter({ visible: true })
}

async function sign(page) {
  const box = await page.getByTestId("signature-pad").boundingBox()
  if (!box) return
  await page.mouse.move(box.x + 30, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 100, box.y + box.height / 2 - 20, { steps: 6 })
  await page.mouse.move(box.x + 170, box.y + box.height / 2 + 16, { steps: 6 })
  await page.mouse.up()
}

// --- The plain screens ----------------------------------------------------
for (const mode of MODES) {
  for (const viewport of VIEWPORTS) {
    for (const screen of SCREENS) {
      const { context, page } = await open(mode, viewport, screen.path)
      await page.waitForTimeout(400)
      await page.screenshot({
        path: join(outDir, `counter-${screen.name}-${mode}-${viewport.name}.png`),
      })
      await context.close()
    }

    // --- Every step of the wizard, driven forward ------------------------
    const tag = `${mode}-${viewport.name}`
    const { context, page } = await open(mode, viewport, "/counter/trade/new")

    // 1. Customer, before and after one is chosen.
    await page.getByLabel("Find them").fill("Jasmine")
    await page.getByRole("button", { name: /Jasmine Okafor/ }).waitFor()
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(outDir, `buyin-1-search-${tag}.png`) })

    await page.getByRole("button", { name: /Jasmine Okafor/ }).click()
    await page.getByText("Selling today").waitFor()
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(outDir, `buyin-1-customer-${tag}.png`) })

    // 2. Items, with a card line and a sealed line.
    await primary(page, "Add items").click()
    await page.getByLabel("Set and number").fill("sv151 199")
    await page.getByRole("option").first().waitFor()
    await page.getByRole("option").first().click()
    await page.getByLabel("Market value for Charizard ex").fill("100")

    await page.getByRole("button", { name: "Sealed", exact: true }).click()
    await page.getByLabel("Title").fill("Surging Sparks Elite Trainer Box")
    await page.getByRole("button", { name: "Add line" }).click()
    await page
      .getByLabel("Market value for Surging Sparks Elite Trainer Box")
      .fill("40")
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(outDir, `buyin-2-items-${tag}.png`) })

    // The override sheet, which is where a reason is required.
    await page.getByRole("button", { name: "Override" }).first().click()
    await page.getByLabel("Cash offer for this line").waitFor()
    await page.waitForTimeout(350)
    await page.screenshot({ path: join(outDir, `buyin-2-override-${tag}.png`) })
    await page.keyboard.press("Escape")
    await page.waitForTimeout(300)

    // 3. Offer, with cash chosen and the customer signed.
    await primary(page, "Make the offer").click()
    await page.getByTestId("tile-cash").waitFor()
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(outDir, `buyin-3-offer-${tag}.png`) })

    await page.getByTestId("tile-cash").click()
    await page
      .getByRole("switch", {
        name: "The customer has heard the terms and agrees to them",
      })
      .click()
    await sign(page)
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(outDir, `buyin-3-signed-${tag}.png`) })

    // 4. The ID gate, skipped for this customer because their ID is good.
    await primary(page, "Check ID").click()
    await page.getByTestId("id-already-verified").waitFor()
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(outDir, `buyin-4-id-known-${tag}.png`) })

    // 5. Done, with the items fanned out.
    await primary(page, "Complete buy-in").click()
    await page.getByRole("heading", { name: "Bought in" }).waitFor()
    await page.waitForTimeout(700)
    await page.screenshot({ path: join(outDir, `buyin-5-done-${tag}.png`) })

    // The A4 receipt.
    await page.getByRole("button", { name: "Receipt", exact: true }).click()
    await page.getByRole("button", { name: "Print" }).waitFor()
    await page.waitForTimeout(400)
    await page.screenshot({
      path: join(outDir, `buyin-receipt-${tag}.png`),
      fullPage: true,
    })
    await context.close()

    // The ID capture, for a customer who has none on file.
    const fresh = await open(mode, viewport, "/counter/trade/new")
    await fresh.page.getByLabel("Find them").fill("Tom")
    await fresh.page.getByRole("button", { name: /Tom Bradbury/ }).first().click()
    await primary(fresh.page, "Add items").click()
    await fresh.page.getByLabel("Set and number").fill("sv151 205")
    await fresh.page.getByRole("option").first().waitFor()
    await fresh.page.getByRole("option").first().click()
    await fresh.page.getByLabel("Market value for Mew ex").fill("60")
    await primary(fresh.page, "Make the offer").click()
    await fresh.page.getByTestId("tile-cash").click()
    await fresh.page
      .getByRole("switch", {
        name: "The customer has heard the terms and agrees to them",
      })
      .click()
    await sign(fresh.page)
    await primary(fresh.page, "Check ID").click()
    await fresh.page.getByTestId("id-photo-input").waitFor()
    await fresh.page.getByTestId("id-photo-input").setInputFiles(idPhoto)
    await fresh.page.getByTestId("id-photo-preview").waitFor()
    await fresh.page.getByLabel("Expires").fill("2032-06-30")
    await fresh.page.getByLabel("Last four digits").fill("4471")
    await fresh.page.getByLabel("Date of birth").fill("1994-03-18")
    await fresh.page.getByLabel("Address").fill("18 Hill Top, Bolsover, S44 6NB")
    await fresh.page.waitForTimeout(400)
    await fresh.page.screenshot({
      path: join(outDir, `buyin-4-id-capture-${tag}.png`),
      fullPage: true,
    })
    await fresh.context.close()

    console.log(`captured ${tag}`)
  }
}

await browser.close()
console.log(`shots in ${outDir}`)
