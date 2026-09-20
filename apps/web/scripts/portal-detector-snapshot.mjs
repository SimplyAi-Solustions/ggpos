/**
 * Saves every My Vault route as a self-contained HTML file, so the Impeccable
 * detector can scan pages that live behind the portal's demo sign-in.
 *
 *   VITE_DEMO_SWITCH=1 pnpm --filter web build   # the switch honours ?demo=1
 *   pnpm --filter web exec vite preview --port 4173      # in one terminal
 *   node apps/web/scripts/portal-detector-snapshot.mjs <outDir> [baseUrl] [w] [h]
 *   IMPECCABLE_BROWSER=/path/to/chromium \
 *     .claude/skills/impeccable/scripts/bin/linux-x64/impeccable detect <outDir>
 *
 * Same reasoning as `detector-snapshot.mjs`, which does this for the counter:
 * the bundled Chromium refuses to launch as root, so a live URL scan is not
 * available and the detector reads saved DOM instead. Its `cramped-padding`
 * rule only sees padding written as an inline style in file mode, so Tailwind
 * `py-*` classes read as zero inset there; that rule's findings are read
 * against the screenshots rather than taken at face value.
 */
import { chromium } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const photo = join(here, "..", "..", "..", "e2e", "fixtures", "id-sample.png")

const outDir = process.argv[2]
const baseUrl = process.argv[3] ?? "http://127.0.0.1:4173"
const width = Number(process.argv[4] ?? 1440)
const height = Number(process.argv[5] ?? 1200)

const DEMO_CUSTOMER_ID = "cust_demo_1"
const DEMO_QR_TOKEN = "demo-4k7m2-token"

/** Signed in: the five tabs and everything they reach. */
const PRIVATE_ROUTES = [
  ["card", "/account"],
  ["quotes", "/account/quotes"],
  ["quote", "/account/quotes/quote_demo_1"],
  ["quote-new", "/account/quotes/new"],
  ["wants", "/account/wants"],
  ["credit", "/account/credit"],
  ["trade-ins", "/account/trade-ins"],
  ["trade-in", "/account/trade-ins/trade_demo_portal"],
  ["guild", "/account/guild"],
  ["rewards", "/account/rewards"],
  ["reward", "/account/rewards/reward_booster"],
  ["reward-refused", "/account/rewards/reward_retro"],
  ["points", "/account/points"],
  ["profile", "/account/me"],
  ["notifications", "/account/notifications"],
]

/** Signed out: the three pages a stranger can reach. */
const PUBLIC_ROUTES = [
  ["signin", "/account"],
  ["card-landing", `/c/${DEMO_QR_TOKEN}`],
]

mkdirSync(outDir, { recursive: true })
const browser = await chromium
  .launch({ executablePath: "/opt/pw-browsers/chromium" })
  .catch(() => chromium.launch())

async function snap(name, path, { signedIn = true, drive } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: "light",
  })
  await context.addInitScript(
    ([customerId]) => {
      window.sessionStorage.setItem("gg-demo", "1")
      window.localStorage.setItem("theme", "light")
      if (customerId) {
        window.localStorage.setItem("gg-demo-customer", customerId)
      } else {
        window.localStorage.removeItem("gg-demo-customer")
      }
    },
    [signedIn ? DEMO_CUSTOMER_ID : ""]
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

async function pickCard(page) {
  await page.getByLabel("Card").fill("Charizard")
  await page.getByRole("option", { name: /Charizard ex/ }).click()
}

for (const [name, path] of PRIVATE_ROUTES) await snap(name, path)
for (const [name, path] of PUBLIC_ROUTES) await snap(name, path, { signedIn: false })

await snap("estimate", "/account/estimate", { drive: pickCard })
await snap("estimate-public", "/estimate", { signedIn: false, drive: pickCard })

await snap("signin-code", "/account", {
  signedIn: false,
  drive: async (page) => {
    await page.getByRole("button", { name: "Send me a code" }).click()
    await page.getByLabel("Code", { exact: true }).fill("48213976")
  },
})

await snap("quote-new-filled", "/account/quotes/new", {
  drive: async (page) => {
    await page.getByTestId("quote-photo-input").setInputFiles([photo, photo, photo])
    await page.getByLabel("Message").fill("Four holos and a boxed SNES game.")
  },
})

await snap("wants-add", "/account/wants", {
  drive: async (page) => {
    await page.getByRole("button", { name: "Add a card" }).first().click()
    await page.getByRole("dialog", { name: "Add a card" }).waitFor()
  },
})

await snap("quote-accept", "/account/quotes/quote_demo_1", {
  drive: async (page) => {
    await page.getByRole("button", { name: "Accept the offer" }).first().click()
    await page.getByRole("dialog", { name: "Accept this offer" }).waitFor()
  },
})

for (const [name, button] of [
  ["profile-privacy", "How we use your data"],
  ["profile-delete", "Delete my account"],
]) {
  await snap(name, "/account/me", {
    drive: async (page) => {
      await page.getByRole("button", { name: button }).first().click()
      await page.getByRole("dialog").waitFor()
    },
  })
}

await browser.close()
console.log(`Wrote ${outDir}`)
