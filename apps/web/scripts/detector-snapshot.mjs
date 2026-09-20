/**
 * Saves each signed-in counter route as a self-contained HTML file, so the
 * Impeccable detector can scan pages that live behind the demo sign-in.
 *
 *   pnpm --filter web build
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

await browser.close()
