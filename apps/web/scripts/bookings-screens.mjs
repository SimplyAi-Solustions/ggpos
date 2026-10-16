/**
 * Screenshots bookings (docs/api-contract-launch.md, section 4) in the
 * states they are judged in: the counter's day view, a booking's sheet, the
 * stations strip, the week, an event's sheet and My Vault's booking, at the
 * tablet's 1180x820 and a phone's 390x844, in both colour modes.
 *
 *   VITE_DEMO_SWITCH=1 pnpm --filter web build        # honours ?demo=1
 *   pnpm --filter web exec vite preview --port 4198    # in one terminal
 *   node apps/web/scripts/bookings-screens.mjs [baseUrl]
 *
 * Output lands in apps/web/scripts/shots/, which is git-ignored. With
 * SNAP_DIR set, each state in light mode at 1180x820 is also saved there as
 * self-contained HTML for the Impeccable detector:
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
const baseUrl = (process.argv[2] ?? "http://127.0.0.1:4198").replace(/\/$/, "")
const snapDir = process.env.SNAP_DIR

const VIEWPORTS = [
  { name: "1180x820", width: 1180, height: 820 },
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

mkdirSync(outDir, { recursive: true })
if (snapDir) mkdirSync(snapDir, { recursive: true })

const browser = await chromium
  .launch({ executablePath: "/opt/pw-browsers/chromium" })
  .catch(() => chromium.launch())

async function open(mode, viewport, path) {
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
  await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" })
  await page.evaluate(() => document.fonts.ready)
  return { context, page }
}

async function shoot(page, name, element) {
  await page.waitForTimeout(450)
  if (element) await element.screenshot({ path: join(outDir, `${name}.png`) })
  else await page.screenshot({ path: join(outDir, `${name}.png`) })
  console.log(`shot ${name}`)
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

for (const mode of MODES) {
  for (const viewport of VIEWPORTS) {
    const tag = `${mode}-${viewport.name}`
    const detect = mode === "light" && viewport.name === "1180x820"

    {
      const { context, page } = await open(mode, viewport, "/counter/bookings?demo=1")
      await page.getByTestId("day-grid").waitFor()
      await shoot(page, `bookings-day-${tag}`)
      if (detect) await snapshot(page, "bookings-day")

      await shoot(page, `bookings-stations-${tag}`, page.getByTestId("stations"))

      await page.getByTestId("day-block").filter({ hasText: "Harper family" }).click()
      await page.getByTestId("booking-sheet").waitFor()
      await shoot(page, `bookings-sheet-${tag}`)
      if (detect) await snapshot(page, "bookings-sheet")
      await page.keyboard.press("Escape")
      await page.getByTestId("booking-sheet").waitFor({ state: "hidden" })

      await page.getByTestId("day-slot").first().click()
      await page.getByTestId("book-sheet").waitFor()
      await shoot(page, `bookings-new-${tag}`)
      await page.keyboard.press("Escape")

      await page.getByRole("tab", { name: "Week" }).click()
      await page.getByTestId("week").waitFor()
      await shoot(page, `bookings-week-${tag}`)

      await page.getByRole("tab", { name: "Events" }).click()
      await page.getByTestId("event-row").first().click()
      await page.getByTestId("event-sheet").waitFor()
      await shoot(page, `bookings-event-${tag}`)
      if (detect) await snapshot(page, "bookings-event")
      await context.close()
    }

    {
      const { context, page } = await open(
        mode,
        viewport,
        "/account/bookings?demo=1&demo_as=cust_demo_1"
      )
      await page.getByTestId("portal-book-screen").waitFor()
      await page.getByRole("button", { name: "Tomorrow" }).click()
      await page.getByTestId("portal-slot").first().click()
      await page.getByTestId("portal-choice").waitFor()
      await shoot(page, `portal-book-${tag}`)
      if (detect) await snapshot(page, "portal-book")
      await context.close()
    }
  }
}

await browser.close()
