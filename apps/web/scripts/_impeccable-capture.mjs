/**
 * TEMPORARY diagnostic script, not part of the app: captures a fully
 * rendered, signed-in snapshot of a guarded /counter route as static HTML,
 * with a <base> tag so the built app's absolute asset paths (/assets/...)
 * still resolve against the running `vite preview` server. Impeccable's URL
 * mode cannot get past the staff-only guard on its own, so this stands in
 * for a real navigation the same way apps/web/scripts/*.mjs seed demo auth
 * via addInitScript before capturing screenshots. Deleted after use.
 */
import { chromium } from "@playwright/test"
import { writeFileSync } from "node:fs"

const baseUrl = (process.argv[2] ?? "http://127.0.0.1:4173").replace(/\/$/, "")
const path = process.argv[3]
const outFile = process.argv[4]

const DEMO_STAFF = {
  id: "staff_demo",
  email: "demo@ggentertainment.co.uk",
  name: "Demo Counter",
  role: "admin",
  active: true,
}

const browser = await chromium
  .launch({ executablePath: "/opt/pw-browsers/chromium" })
  .catch(() => chromium.launch())

const context = await browser.newContext({
  viewport: { width: 1440, height: 1200 },
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
await page.waitForTimeout(400)

const html = await page.content()
const withBase = html.replace(/<head>/, `<head><base href="${baseUrl}/">`)
writeFileSync(outFile, withBase)
console.log(`saved ${outFile} (${withBase.length} bytes)`)

await browser.close()
