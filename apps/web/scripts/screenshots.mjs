/**
 * Screenshots the kit page in both modes at desktop and phone widths, plus the
 * two reference rebuilds on their own at real size so they can be held against
 * docs/design-references/.
 *
 *   pnpm --filter web dev            # in one terminal
 *   node apps/web/scripts/screenshots.mjs [baseUrl]
 *
 * Output lands in apps/web/scripts/shots/, which is git-ignored.
 */
import { chromium } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "shots")
const baseUrl = (process.argv[2] ?? "http://localhost:5173/").replace(/\/$/, "")

const VIEWPORTS = [
  { name: "1440x1200", width: 1440, height: 1200 },
  { name: "390x844", width: 390, height: 844 },
]
const MODES = ["light", "dark"]
const SECTIONS = [
  "colour",
  "type",
  "controls",
  "data",
  "product-images",
  "brand",
  "motion",
  "reference-match",
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
    ([theme]) => window.localStorage.setItem("theme", theme),
    [mode]
  )
  const page = await context.newPage()
  await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(500)
  return { context, page }
}

for (const mode of MODES) {
  for (const viewport of VIEWPORTS) {
    const tag = `${mode}-${viewport.name}`

    // --- the kit page (at /kit; / is the sign-in screen) ---
    const kit = await open(mode, viewport, "/kit")
    await kit.page.screenshot({ path: join(outDir, `kit-${tag}-top.png`) })
    await kit.page.screenshot({ path: join(outDir, `kit-${tag}-full.png`), fullPage: true })

    // The sticky header would otherwise paint over element screenshots.
    await kit.page.addStyleTag({ content: "header.sticky{position:static!important}" })
    await kit.page.waitForTimeout(150)

    for (const id of SECTIONS) {
      const el = kit.page.locator(`#${id}`)
      if ((await el.count()) === 0) continue
      await el.scrollIntoViewIfNeeded()
      await kit.page.waitForTimeout(120)
      await el.screenshot({ path: join(outDir, `${id}-${tag}.png`) })
    }

    // --- the two rebuilds beside their references ---
    // Both live inside the kit's "Reference match" section now (the old
    // /?screen= pages are gone), one comparison block each, in order.
    const blocks = kit.page.locator("#reference-match div.flex.flex-col > div")
    for (const [index, screen] of ["atlas", "nova"].entries()) {
      const block = blocks.nth(index)
      if ((await block.count()) === 0) continue
      await block.scrollIntoViewIfNeeded()
      await kit.page.waitForTimeout(120)
      await block.screenshot({ path: join(outDir, `screen-${screen}-${tag}.png`) })
    }
    await kit.context.close()

    console.log(`captured ${tag}`)
  }
}

await browser.close()
console.log(`shots in ${outDir}`)
