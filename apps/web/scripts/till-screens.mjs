/**
 * Screenshots the till (DESIGN.md, section 10) in the states it is judged
 * in: empty, a ticket of five mixed lines with a customer, the cash step,
 * the card step and done, at the tablet's 1180x820, the Mac's 1440x900 and
 * a phone's 390x844, in both colour modes. Then part-exchange and exchanges
 * (docs/api-contract-epos.md, section 7) at 1180x820 and 390x844: the
 * Trade-in panel, the ticket with a trade, Settle with the surplus in cash,
 * and a return exchanged in the ticket with its tender pane.
 *
 *   VITE_DEMO_SWITCH=1 pnpm --filter web build        # honours ?demo=1
 *   pnpm --filter web exec vite preview --port 4181    # in one terminal
 *   node apps/web/scripts/till-screens.mjs [baseUrl]
 *
 * Output lands in apps/web/scripts/shots/, which is git-ignored. With
 * SNAP_DIR set, each part-exchange state in light mode is also saved there
 * as self-contained HTML for the Impeccable detector:
 *
 *   IMPECCABLE_BROWSER=/path/to/chromium \
 *     .claude/skills/impeccable/scripts/bin/linux-x64/impeccable detect "$SNAP_DIR"
 */
import { chromium } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
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
const BOX = "Surging Sparks Elite Trainer Box"

/** Where the detector's HTML goes, when it is wanted. */
const snapDir = process.env.SNAP_DIR

mkdirSync(outDir, { recursive: true })
if (snapDir) mkdirSync(snapDir, { recursive: true })

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

/** The page as one self-contained file, styles inlined and scripts gone. */
async function snapshot(page, name) {
  if (!snapDir) return
  const html = await page.evaluate(async () => {
    for (const link of Array.from(document.querySelectorAll('link[rel="stylesheet"]'))) {
      const css = await fetch(link.href).then((r) => r.text())
      const style = document.createElement("style")
      style.textContent = css
      link.replaceWith(style)
    }
    for (const script of Array.from(document.querySelectorAll("script"))) script.remove()
    return `<!doctype html>\n${document.documentElement.outerHTML}`
  })
  writeFileSync(join(snapDir, `${name}.html`), html)
}

/** A part-exchange for Jasmine against Mabel: a Charizard at £100 and a sealed box at £40. */
async function tradeTicket(page, phone) {
  await scan(page, JASMINE)
  await page.getByText(/Jasmine Okafor attached/).waitFor()
  await scan(page, MABEL)
  await page.getByText(/Mabel, Heir to Cragflame added/).waitFor()
  if (phone) await page.getByTestId("till-ticket-tab").click()
  await page.getByTestId("till-trade-in").filter({ visible: true }).click()
  const panel = page.getByTestId("till-trade-panel")
  await panel.waitFor()
  await panel.getByLabel("Set and number").fill("sv151 199")
  await page.getByRole("option", { name: /Charizard ex/ }).first().click()
  await panel.getByLabel("Market value for Charizard ex").fill("100")
  await panel.getByRole("button", { name: "Sealed", exact: true }).click()
  await panel.getByLabel("Title").fill(BOX)
  await panel.getByRole("button", { name: "Add line" }).click()
  await panel.getByLabel(`Market value for ${BOX}`).fill("40")
  await panel.getByTestId("till-trade-value").waitFor()
  await page.evaluate(() => window.scrollTo(0, 0))
  await panel.evaluate((el) => el.closest(".overflow-y-auto")?.scrollTo(0, 0))
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

    // ---- Part-exchange and exchanges (section 7) ----------------------------
    if (viewport.name === "1440x900") continue
    // One set of detector snapshots, in light mode, is enough.
    const snap = (page, name) =>
      mode === "light" ? snapshot(page, `${name}-${viewport.name}`) : Promise.resolve()

    {
      const { context, page } = await open(mode, viewport)
      await page.getByTestId("till-tiles").waitFor()
      await tradeTicket(page, phone)
      await shoot(page, `till-trade-panel-${tag}`)
      await snap(page, "trade-panel")

      // The ticket with its trade group and what is left to pay.
      if (phone) await page.getByTestId("till-ticket-tab").click()
      else await page.getByTestId("till-trade-close").click()
      await page.getByTestId("ticket-trade").waitFor()
      await shoot(page, `till-trade-ticket-${tag}`)
      await snap(page, "trade-ticket")

      // Settle: worth more than the ticket, the surplus taken in cash.
      await page.getByTestId("till-pay").filter({ visible: true }).click()
      await page.getByTestId("till-settle").waitFor()
      await page.getByTestId("till-surplus-cash").click()
      await page.getByTestId("till-surplus-difference").waitFor()
      await shoot(page, `till-settle-${tag}`)
      await snap(page, "settle")
      await context.close()
    }

    {
      const { context, page } = await open(mode, viewport)
      await page.getByTestId("till-tiles").waitFor()
      // The morning's Llanowar Elves, back off its receipt, for Mabel.
      await scan(page, "GGS000456")
      const sheet = page.getByTestId("returns-sheet")
      await sheet.getByTestId("returns-sale-number").waitFor()
      await sheet.getByLabel("Reason").fill("Wrong card")
      await sheet.getByTestId("returns-exchange").click()
      await sheet.waitFor({ state: "hidden" })
      await scan(page, MABEL)
      await page.getByText(/Mabel, Heir to Cragflame added/).waitFor()
      if (phone) await page.getByTestId("till-ticket-tab").click()
      await page.getByTestId("ticket-returns").waitFor()
      await shoot(page, `till-exchange-ticket-${tag}`)
      await snap(page, "exchange-ticket")

      await pay(page)
      await page.getByTestId("till-tender-applied").waitFor()
      await shoot(page, `till-exchange-pay-${tag}`)
      await snap(page, "exchange-pay")
      await context.close()
    }
  }
}

await browser.close()
