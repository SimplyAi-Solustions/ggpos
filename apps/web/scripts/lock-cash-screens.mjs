/**
 * Screenshots the lock and cash-up package's screens: the lock screen (the
 * roster, the PIN step and a wrong PIN), the manager approval dialog,
 * opening the till, the Z count and a Z report, the staff list and the
 * Tills section of Settings, at the tablet's 1180x820 and a phone's
 * 390x844, light and dark.
 *
 *   VITE_DEMO_SWITCH=1 pnpm --filter web build   # the switch honours ?demo=1
 *   pnpm --filter web exec vite preview --port 4182   # in one terminal
 *   node apps/web/scripts/lock-cash-screens.mjs [baseUrl]
 *
 * Output lands in apps/web/scripts/shots/, which is git-ignored. The demo
 * browser is a registered till from the start, so the PIN lock is what
 * shows; the demo PINs are in `src/lib/api/demo/staff.ts`.
 */
import { chromium } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "shots")
const baseUrl = (process.argv[2] ?? "http://127.0.0.1:4182").replace(/\/$/, "")

const VIEWPORTS = [
  { name: "1180x820", width: 1180, height: 820 },
  { name: "390x844", width: 390, height: 844 },
]
const MODES = ["light", "dark"]

/** The same shape lib/auth.ts persists, so the guard lets us straight in. */
const ADMIN = {
  id: "staff_demo",
  email: "demo@ggentertainment.co.uk",
  name: "Demo Counter",
  role: "admin",
  active: true,
}
const MEMBER = {
  id: "staff_demo_member",
  email: "sam@ggentertainment.co.uk",
  name: "Sam Bell",
  role: "staff",
  active: true,
}

mkdirSync(outDir, { recursive: true })

const browser = await chromium
  .launch({ executablePath: "/opt/pw-browsers/chromium" })
  .catch(() => chromium.launch())

/** A page in the demo shop, signed in as `staff`, optionally already locked. */
async function open(mode, viewport, path, { staff = ADMIN, locked = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    colorScheme: mode,
  })
  await context.addInitScript(
    ([theme, person, lock]) => {
      window.sessionStorage.setItem("gg-demo", "1")
      window.localStorage.setItem("theme", theme)
      window.localStorage.setItem("gg-demo-staff", JSON.stringify(person))
      if (lock) {
        window.localStorage.setItem(
          "gg.counter.locked",
          JSON.stringify({ staff: person.id, at: new Date().toISOString() })
        )
      } else {
        window.localStorage.removeItem("gg.counter.locked")
      }
    },
    [mode, staff, locked]
  )
  const page = await context.newPage()
  const join = path.includes("?") ? "&" : "?"
  await page.goto(`${baseUrl}${path}${join}demo=1`, { waitUntil: "networkidle" })
  await page.evaluate(() => document.fonts.ready)
  return { context, page }
}

async function shoot(page, name, { fullPage = true, element = null } = {}) {
  await page.waitForTimeout(400)
  const path = join(outDir, `${name}.png`)
  if (element) await page.locator(element).screenshot({ path })
  else await page.screenshot({ path, fullPage })
  console.log(`wrote ${path}`)
}

/** Below 900px a screen's block is docked; take whichever is on screen. */
function primary(page, name) {
  return page.getByRole("button", { name, exact: true }).filter({ visible: true })
}

async function countDrawer(page, prefix) {
  const counts = { 2000: "3", 1000: "2", 500: "4", 100: "6", 50: "3", 20: "8", 10: "5" }
  for (const [value, count] of Object.entries(counts)) {
    await page.locator(`#${prefix}-${value}`).fill(count)
  }
}

for (const viewport of VIEWPORTS) {
  for (const mode of MODES) {
    const tag = `${viewport.name}-${mode}`

    // ---- The lock screen ----
    {
      const { context, page } = await open(mode, viewport, "/counter", { locked: true })
      await page.getByTestId("roster-tile").first().waitFor()
      await shoot(page, `lock-roster-${tag}`, { fullPage: false })
      await page.getByRole("button", { name: "Mo Khan" }).click()
      await shoot(page, `lock-pin-${tag}`, { fullPage: false })
      await page.keyboard.type("1111")
      await page.getByText(/That PIN is not right/).waitFor()
      await shoot(page, `lock-wrong-pin-${tag}`, { fullPage: false })
      await context.close()
    }

    // ---- Manager approval, asked for by a member of staff ----
    {
      const { context, page } = await open(mode, viewport, "/counter/cash?action=no_sale", {
        staff: MEMBER,
      })
      await page.getByLabel("Why").fill("Change for the float")
      await page.getByRole("button", { name: "Open the drawer" }).click()
      await page.getByTestId("override-dialog").waitFor()
      await shoot(page, `approval-${tag}`, { fullPage: false })
      await page.getByRole("button", { name: "Mo Khan" }).click()
      await shoot(page, `approval-pin-${tag}`, { fullPage: false })
      await context.close()
    }

    // ---- The Z count, the Z report, then opening the till again ----
    {
      const { context, page } = await open(mode, viewport, "/counter/cash?action=z")
      await countDrawer(page, "z")
      await page.getByLabel("Tide card total").fill("132.43")
      await shoot(page, `z-count-${tag}`)
      await primary(page, "Close the till").click()
      await page.getByTestId("till-report").waitFor()
      await shoot(page, `z-report-${tag}`)
      await page.getByRole("button", { name: "Back", exact: true }).click()
      await page.getByRole("heading", { name: "Open the till" }).waitFor()
      await shoot(page, `open-till-${tag}`)
      await context.close()
    }

    // ---- Cash up with the till open ----
    {
      const { context, page } = await open(mode, viewport, "/counter/cash")
      await page.getByTestId("till-state").waitFor()
      await shoot(page, `cash-up-${tag}`)
      await context.close()
    }

    // ---- Staff ----
    {
      const { context, page } = await open(mode, viewport, "/counter/staff")
      await page.getByRole("heading", { name: "Staff" }).waitFor()
      await page.getByText("Mo Khan").filter({ visible: true }).first().waitFor()
      await shoot(page, `staff-${tag}`)
      await context.close()
    }

    // ---- Settings, Tills ----
    {
      const { context, page } = await open(mode, viewport, "/counter/settings")
      await page.getByTestId("tills-section").waitFor()
      await page.getByTestId("tills-section").scrollIntoViewIfNeeded()
      await shoot(page, `settings-tills-${tag}`, { element: "[data-testid='tills-section']" })
      await page.getByTestId("permissions-table").scrollIntoViewIfNeeded()
      await shoot(page, `settings-permissions-${tag}`, {
        element: "[data-testid='permissions-table']",
      })
      await context.close()
    }
  }
}

await browser.close()
