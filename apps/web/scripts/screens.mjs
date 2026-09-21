/**
 * Screenshots the counter screens, signed in against the demo fixtures, so
 * they can be held against docs/design-references/ without a PocketBase.
 *
 *   VITE_DEMO_SWITCH=1 pnpm --filter web build   # the switch honours ?demo=1
 *   pnpm --filter web exec vite preview --port 4173   # in one terminal
 *   node apps/web/scripts/screens.mjs [baseUrl]
 *
 * Output lands in apps/web/scripts/shots/, which is git-ignored.
 * `screenshots.mjs` still covers the kit page and the two reference rebuilds.
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
/**
 * The demo Charizard's code. Built here rather than imported, so this script
 * stays a plain Node module with no TypeScript loader: the check character is
 * the weighted mod-32 in packages/shared/src/sku.ts.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
function ggCode(letter, body) {
  let sum = 0
  const chars = letter + body
  for (let i = 0; i < chars.length; i++) sum += CROCKFORD.indexOf(chars[i]) * (i + 1)
  return `GG${letter}${body}${CROCKFORD[sum % 32]}`
}
const DEMO_SKU = ggCode("S", "7F3K2")

const SCREENS = [
  { name: "scan", path: "/counter/scan" },
  { name: "add-stock", path: "/counter/stock/new" },
  { name: "home", path: "/counter" },
  { name: "stock", path: "/counter/stock" },
  { name: "login", path: "/login", signedIn: false },

  // Selling, cash and labels. `prepare` drives the screen into the state a
  // static URL cannot reach, because the demo stores live in memory for the
  // tab: a basket has to be scanned and a drawer has to be opened.
  { name: "sell-empty", path: "/counter/sell" },
  {
    name: "sell-basket",
    path: "/counter/sell",
    async prepare(page) {
      const field = page.getByTestId("sell-scan-field")
      await field.fill(DEMO_SKU)
      await field.press("Enter")
      await page.getByTestId("basket").waitFor()
      await page.getByRole("button", { name: "SumUp card", exact: true }).click()
    },
  },
  { name: "cash-closed", path: "/counter/cash" },
  {
    name: "cash-open",
    path: "/counter/cash",
    async prepare(page) {
      await page.getByLabel("Float").fill("100.00")
      await page
        .getByRole("button", { name: "Open session", exact: true })
        .filter({ visible: true })
        .click()
      await page.getByTestId("cash-expected").waitFor()
    },
  },
  { name: "item", path: `/counter/stock/${DEMO_SKU}` },
  { name: "labels", path: "/counter/labels" },
  {
    name: "label-print",
    path: "/labels/print?jobs=label_demo_1,label_demo_2&print=0",
    signedIn: false,
  },
]

/** The same shape lib/auth.ts persists, so the guard lets us straight in. */
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

for (const mode of MODES) {
  for (const viewport of VIEWPORTS) {
    for (const screen of SCREENS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        colorScheme: mode,
      })
      await context.addInitScript(
        ([theme, staff, signedIn]) => {
          window.sessionStorage.setItem("gg-demo", "1")
          window.localStorage.setItem("theme", theme)
          if (signedIn) {
            window.localStorage.setItem("gg-demo-staff", JSON.stringify(staff))
          } else {
            window.localStorage.removeItem("gg-demo-staff")
          }
        },
        [mode, DEMO_STAFF, screen.signedIn !== false]
      )

      const page = await context.newPage()
      const q = screen.path.includes("?") ? "&" : "?"
      await page.goto(`${baseUrl}${screen.path}${q}demo=1`, {
        waitUntil: "networkidle",
      })
      await page.evaluate(() => document.fonts.ready)
      if (screen.prepare) await screen.prepare(page)
      await page.waitForTimeout(400)
      await page.screenshot({
        path: join(outDir, `counter-${screen.name}-${mode}-${viewport.name}.png`),
      })
      await context.close()
    }
    console.log(`captured ${mode}-${viewport.name}`)
  }
}

/**
 * The states a static URL cannot reach: the catalogue dropdown, a chosen
 * card, the done seal, the palette and the inline scan error. Desktop and
 * phone, light only, because the token check happens on the plain screens.
 */
async function openSignedIn(viewport, path) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
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
  return { context, page }
}

for (const viewport of VIEWPORTS) {
  const tag = viewport.name

  // Catalogue dropdown, then the chosen card with its preview.
  {
    const { context, page } = await openSignedIn(viewport, "/counter/stock/new")
    await page.getByLabel("Set and number").fill("sv151 199")
    await page.getByRole("option").first().waitFor()
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(outDir, `state-card-search-${tag}.png`) })

    await page.getByRole("option").first().click()
    await page.getByRole("button", { name: "NM", exact: true }).click()
    await page.getByLabel("Cost").fill("180")
    await page.getByLabel("Price").fill("324.99")
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(outDir, `state-card-chosen-${tag}.png`) })

    await page
      .getByRole("button", { name: "Save item" })
      .filter({ visible: true })
      .click()
    await page.getByRole("heading", { name: "Saved" }).waitFor()
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(outDir, `state-saved-seal-${tag}.png`) })
    await context.close()
  }

  // The inline scan error, under the field and not in a toast.
  {
    const { context, page } = await openSignedIn(viewport, "/counter/scan")
    await page.getByTestId("scan-field").fill("NOTACODE")
    await page.getByTestId("scan-field").press("Enter")
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(outDir, `state-scan-error-${tag}.png`) })
    await context.close()
  }

  // The idle lock, reached by fast-forwarding past ten quiet minutes.
  {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
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
    await page.clock.install()
    await page.goto(`${baseUrl}/counter?demo=1`, { waitUntil: "networkidle" })
    await page.getByRole("heading", { name: "Today" }).waitFor()
    await page.clock.fastForward("11:00")
    await page.getByRole("dialog", { name: "Locked" }).waitFor()
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(outDir, `state-idle-lock-${tag}.png`) })
    await context.close()
  }

  // The command palette over the counter.
  {
    const { context, page } = await openSignedIn(viewport, "/counter")
    await page.keyboard.press("ControlOrMeta+k")
    await page.waitForTimeout(250)
    await page.keyboard.type("charizard")
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(outDir, `state-palette-${tag}.png`) })
    await context.close()
  }

  console.log(`captured states ${tag}`)
}

await browser.close()
console.log(`shots in ${outDir}`)
