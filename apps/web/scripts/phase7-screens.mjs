/**
 * Screenshots the Phase 7 counter screens: the label queue with a printer
 * connected, printing and failed, the bulk reprint sheet and the printer
 * sheet, the card payment on Sell in each of its four states, the Card
 * reader section under Settings, and the keyboard shortcut overlay.
 *
 *   VITE_DEMO_SWITCH=1 pnpm --filter web build   # the switch honours ?demo=1
 *   pnpm --filter web exec vite preview --port 4173   # in one terminal
 *   node apps/web/scripts/phase7-screens.mjs [baseUrl]
 *
 * Output lands in apps/web/scripts/shots/, which is git-ignored.
 * `screenshots.mjs` covers the kit page and the two rebuilt reference
 * screens, and `screens.mjs`, `customers-trade-screens.mjs`,
 * `pricing-screens.mjs`, `quotes-screens.mjs`, `loyalty-screens.mjs`,
 * `settings-offline-count-screens.mjs` and `portal-screens.mjs` cover the
 * rest.
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

/** The same shape lib/auth.ts persists, so the guard lets us straight in. */
const DEMO_STAFF = {
  id: "staff_demo",
  email: "demo@ggentertainment.co.uk",
  name: "Demo Counter",
  role: "admin",
  active: true,
}

// The demo Charizard, built the way packages/shared/src/sku.ts builds it
// (this file is plain JS, so the check character is worked out here).
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
function ggCode(letter, body) {
  let sum = 0
  const chars = letter + body
  for (let i = 0; i < chars.length; i++) sum += CROCKFORD.indexOf(chars[i]) * (i + 1)
  return `GG${letter}-${body}${CROCKFORD[sum % 32]}`
}
const CARD_SKU = ggCode("S", "7F3K2")

/**
 * A T003 that records what it is sent. `hold` keeps the first label on the
 * printer so the queue can be photographed mid-job; `fail` refuses every
 * label, which is how the failed state is reached.
 */
function fakePrinter({ hold = false, fail = false } = {}) {
  return ([holdIt, failIt]) => {
    const device = {
      productName: "ORGSTA T003",
      opened: false,
      configuration: null,
      configurations: [
        {
          configurationValue: 1,
          interfaces: [
            {
              interfaceNumber: 0,
              alternate: {
                alternateSetting: 0,
                interfaceClass: 7,
                endpoints: [{ endpointNumber: 1, direction: "out", type: "bulk" }],
              },
            },
          ],
        },
      ],
      async open() {
        device.opened = true
      },
      async selectConfiguration() {
        device.configuration = device.configurations[0]
      },
      async claimInterface() {},
      async transferOut(_endpoint, data) {
        if (failIt) {
          const error = new Error("The device was disconnected.")
          error.name = "NetworkError"
          throw error
        }
        while (holdIt) await new Promise((resolve) => setTimeout(resolve, 60))
        return { status: "ok", bytesWritten: data.byteLength }
      },
    }
    Object.defineProperty(navigator, "usb", {
      configurable: true,
      value: {
        requestDevice: async () => device,
        getDevices: async () => [device],
      },
    })
  }
}

mkdirSync(outDir, { recursive: true })

const browser = await chromium
  .launch({ executablePath: "/opt/pw-browsers/chromium" })
  .catch(() => chromium.launch())

/** A page in the demo shop, signed in as the demo admin. */
async function open(mode, viewport, path, { usb = null, reader = "" } = {}) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    colorScheme: mode,
  })
  await context.addInitScript(
    ([theme, staff, readerMode]) => {
      window.sessionStorage.setItem("gg-demo", "1")
      window.localStorage.setItem("theme", theme)
      window.localStorage.setItem("gg-demo-staff", JSON.stringify(staff))
      window.localStorage.removeItem("gg-printer-auto")
      if (readerMode) window.localStorage.setItem("gg-demo-reader", readerMode)
      else window.localStorage.removeItem("gg-demo-reader")
    },
    [mode, DEMO_STAFF, reader]
  )
  if (usb === "none") {
    await context.addInitScript(() => {
      Reflect.deleteProperty(Navigator.prototype, "usb")
      Reflect.deleteProperty(navigator, "usb")
    })
  } else if (usb) {
    await context.addInitScript(fakePrinter(usb), [usb.hold === true, usb.fail === true])
  }
  const page = await context.newPage()
  await page.goto(`${baseUrl}${path}?demo=1`, { waitUntil: "networkidle" })
  await page.evaluate(() => document.fonts.ready)
  return { context, page }
}

async function shoot(page, name, { fullPage = true } = {}) {
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(outDir, `${name}.png`), fullPage })
  console.log(`shot ${name}`)
}

/** The Sell screen with the demo card in the basket. */
async function basket(page) {
  const field = page.getByTestId("sell-scan-field")
  await field.fill(CARD_SKU)
  await field.press("Enter")
  await page.getByTestId("basket").waitFor()
}

for (const mode of MODES) {
  for (const viewport of VIEWPORTS) {
    const tag = `${mode}-${viewport.name}`

    // ---- The label queue, with a printer to connect ----------------------
    {
      const { context, page } = await open(mode, viewport, "/counter/labels", {
        usb: { hold: true },
      })
      await page.getByTestId("connect-printer").waitFor()
      await shoot(page, `labels-queue-${tag}`)

      await page.getByTestId("connect-printer").click()
      await page.getByTestId("printer-name").waitFor()
      await page.getByRole("switch", { name: "Auto-print" }).click()
      await page.getByText("Printing on Counter PC").first().waitFor()
      await shoot(page, `labels-printing-${tag}`)

      await page.getByRole("button", { name: "Printer settings" }).click()
      await page.getByTestId("printer-sheet").waitFor()
      await shoot(page, `labels-printer-sheet-${tag}`, { fullPage: false })
      await context.close()
    }

    // ---- A label the printer would not take ------------------------------
    {
      const { context, page } = await open(mode, viewport, "/counter/labels", {
        usb: { fail: true },
      })
      await page.getByTestId("connect-printer").click()
      await page.getByTestId("printer-name").waitFor()
      await page.getByRole("switch", { name: "Auto-print" }).click()
      await page.getByTestId("printer-error").waitFor()
      // Three goes, and then the job stops and waits for somebody.
      await page.getByRole("button", { name: "Failed", exact: true }).click()
      await page.getByRole("button", { name: "Queue again" }).first().waitFor()
      await shoot(page, `labels-failed-${tag}`)
      await context.close()
    }

    // ---- Bulk reprint ----------------------------------------------------
    {
      const { context, page } = await open(mode, viewport, "/counter/labels")
      await page.getByTestId("bulk-reprint").click()
      await page.getByTestId("bulk-reprint-sheet").waitFor()
      await page.getByLabel("Buy-in").fill("GG-BI-000001")
      await shoot(page, `labels-bulk-buyin-${tag}`, { fullPage: false })

      await page.getByRole("button", { name: "Dates", exact: true }).click()
      await page.getByLabel("From", { exact: true }).fill("2026-09-01")
      await page.getByLabel("To", { exact: true }).fill("2026-09-20")
      await shoot(page, `labels-bulk-dates-${tag}`, { fullPage: false })

      await page.getByRole("button", { name: "Queue labels" }).click()
      await page.getByTestId("bulk-outcome").waitFor()
      await shoot(page, `labels-bulk-queued-${tag}`, { fullPage: false })
      await context.close()
    }

    // ---- A browser with no WebUSB ----------------------------------------
    {
      const { context, page } = await open(mode, viewport, "/counter/labels", {
        usb: "none",
      })
      await page.getByText("Queued for the counter printer.").waitFor()
      await shoot(page, `labels-no-usb-${tag}`)
      await context.close()
    }

    // ---- Sell: the card reader -------------------------------------------
    {
      const { context, page } = await open(mode, viewport, "/counter/sell")
      await basket(page)
      await page.getByTestId("take-card-payment").waitFor()
      await shoot(page, `sell-card-action-${tag}`)

      await page.getByTestId("take-card-payment").click()
      await page.getByTestId("card-payment-sheet").waitFor()
      await shoot(page, `sell-card-waiting-${tag}`, { fullPage: false })
      await context.close()
    }

    // The card the reader would not take.
    {
      const { context, page } = await open(mode, viewport, "/counter/sell", {
        reader: "fail",
      })
      await basket(page)
      await page.getByTestId("take-card-payment").click()
      await page.getByRole("button", { name: "Try again" }).waitFor()
      await shoot(page, `sell-card-declined-${tag}`, { fullPage: false })
      await context.close()
    }

    // Money taken on a sale that will not complete: a split with cash in it
    // and no drawer open.
    {
      const { context, page } = await open(mode, viewport, "/counter/sell")
      await basket(page)
      await page.getByRole("button", { name: "Mixed", exact: true }).click()
      await page.getByLabel("Cash").fill("10.00")
      await page.getByLabel("SumUp card").fill("314.99")
      await page.getByTestId("take-card-payment").click()
      await page.getByTestId("card-payment-code").waitFor()
      await shoot(page, `sell-card-taken-${tag}`, { fullPage: false })

      await page.getByRole("button", { name: "Back to the sale" }).click()
      await page.getByTestId("card-payment-held").waitFor()
      await shoot(page, `sell-card-held-${tag}`)
      await context.close()
    }

    // ---- Settings: the card reader ---------------------------------------
    {
      const { context, page } = await open(mode, viewport, "/counter/settings")
      await page.getByTestId("card-reader").waitFor()
      await page
        .getByRole("heading", { level: 2, name: "Card reader" })
        .scrollIntoViewIfNeeded()
      await page.waitForTimeout(200)
      await shoot(page, `settings-card-reader-${tag}`, { fullPage: false })
      await context.close()
    }

    // A shop with SumUp set up and nothing paired yet.
    {
      const { context, page } = await open(mode, viewport, "/counter/settings", {
        reader: "unpaired",
      })
      await page.getByTestId("card-reader").waitFor()
      await page
        .getByRole("heading", { level: 2, name: "Card reader" })
        .scrollIntoViewIfNeeded()
      await page.waitForTimeout(200)
      await shoot(page, `settings-card-reader-unpaired-${tag}`, { fullPage: false })
      await context.close()
    }

    // ---- The keyboard shortcuts ------------------------------------------
    {
      const { context, page } = await open(mode, viewport, "/counter")
      await page.getByRole("heading", { name: "Today" }).waitFor()
      await page.keyboard.press("?")
      await page.getByTestId("shortcut-overlay").waitFor()
      await shoot(page, `shortcut-overlay-${tag}`, { fullPage: false })
      await context.close()
    }
  }
}

await browser.close()
