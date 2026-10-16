/**
 * Freezes the live-pricing screens to self-contained HTML, so the Impeccable
 * detector can scan states that only exist behind the demo sign-in and after
 * a card has been chosen.
 *
 *   VITE_DEMO_SWITCH=1 pnpm --filter web build   # the switch honours ?demo=1
 *   pnpm --filter web exec vite preview --port 4173      # in one terminal
 *   node apps/web/scripts/pricing-detector.mjs <outDir> [baseUrl] [w] [h]
 *   IMPECCABLE_BROWSER=/path/to/chromium \
 *     .claude/skills/impeccable/scripts/bin/linux-x64/impeccable detect <outDir>
 *
 * Same approach and the same caveat as `detector-snapshot.mjs`: in file mode
 * the detector's `cramped-padding` rule only sees padding written as an
 * inline style, so Tailwind `py-*` classes read as zero inset. A live URL
 * scan does not have that problem, but the bundled Chromium refuses to launch
 * as root and takes no --no-sandbox flag.
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
/** The demo Charizard, which has an item on the shelf and a full price book. */
const SKU = ggCode("S", "7F3K2")

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
    // The detector's `cramped-padding` rule only reads inline padding in file
    // mode, so every Tailwind `py-*` reads as zero and correctly spaced rows
    // are reported as flush against their hairline. Copying the computed
    // padding onto the element changes nothing about the layout and lets the
    // rule see what the browser actually painted.
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const { paddingTop, paddingRight, paddingBottom, paddingLeft } =
        getComputedStyle(el)
      const padding = [paddingTop, paddingRight, paddingBottom, paddingLeft]
      if (padding.some((value) => parseFloat(value) > 0)) {
        el.style.padding = padding.join(" ")
      }
    }
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

async function pickCharizard(page) {
  await page.getByLabel("Set and number").fill("sv151 199")
  await page.getByRole("option").first().waitFor()
  await page.getByRole("option").first().click()
}

// Add stock with a card chosen, so the market section and its sources render.
await snap("addstock-priced", "/counter/stock/new", async (page) => {
  await pickCharizard(page)
  await page.getByTestId("price-sources").waitFor()
})

// The item page, whose Market section prices what is already on the shelf.
await snap("item-market", `/counter/stock/${SKU}`, async (page) => {
  await page.getByTestId("price-sources").waitFor()
})

// Price check on Scan.
await snap("price-check", "/counter/scan", async (page) => {
  await page.getByRole("button", { name: "Price check", exact: true }).click()
  const field = page.getByTestId("scan-field")
  await field.fill("sv151 199")
  await field.press("Enter")
  await page.getByTestId("price-check-hit").first().click()
  await page.getByTestId("price-check").waitFor()
})

// A buy-in line priced from a source, with the whole view open on the line.
await snap("buyin-priced", "/counter/trade/new", async (page) => {
  await page.getByLabel("Find them").fill("Jasmine")
  await page.getByRole("button", { name: /Jasmine Okafor/ }).click()
  await primary(page, "Add items").click()
  await pickCharizard(page)
  const line = page.getByTestId("trade-line").first()
  await line.getByTestId("market-source").waitFor()
  await line.getByTestId("market-source").click()
  await line.getByTestId("price-sources").waitFor()
})

await browser.close()
