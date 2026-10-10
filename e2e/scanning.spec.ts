import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { chromium, expect, test, type Page } from "@playwright/test"

import { buildCode } from "../packages/shared/src/sku"

/**
 * Barcode scanning on the counter (docs/api-contract-launch.md, section 6;
 * deploy/README.md, "Barcode scanners"), as far as Playwright's Chromium
 * lets it be driven:
 *
 * - **The camera**: Chromium is handed a fake camera that films the demo
 *   Charizard's QR label. On Linux Chromium has no BarcodeDetector, so this
 *   is the zxing-wasm path Safari on the Mac takes, with its wasm served from
 *   the app's own origin. A BarcodeDetector that reads no QR codes (an
 *   Android tablet without the Play services module) must fall back to the
 *   same path, and one that does read them (Chrome on the tablet and the Mac)
 *   is used.
 * - **The keyboard wedge**: a USB or Bluetooth scanner types the code and
 *   Enter faster than a person can, with nothing focused, with or without a
 *   prefix character left on.
 *
 * The webcam's Take photo is here too, because it needs the same fake
 * camera: the capture guide over the live picture, and the photo cropped to
 * exactly what was inside it.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"
/** The demo Charizard's label. */
const CHARIZARD = buildCode("single", "7F3K2")

/**
 * A one-frame Y4M video of the label's QR code, black on white, which
 * Chromium loops as its fake camera. Written once per run into the temp
 * directory, from the QR modules bwip-js (the app's own barcode library)
 * draws.
 */
function fakeCamera(text: string): string {
  const dir = join(tmpdir(), "gg-e2e-scanning")
  const file = join(dir, `qr-${text}.y4m`)
  if (existsSync(file)) return file
  mkdirSync(dir, { recursive: true })
  const require = createRequire(join(__dirname, "..", "apps", "web", "package.json"))
  const bwip = require("bwip-js") as {
    raw: (options: Record<string, unknown>) => { pixs: number[]; pixx: number; pixy: number }[]
  }
  const symbol = bwip.raw({ bcid: "qrcode", text })[0]!
  const width = 640
  const height = 480
  const scale = 12
  const quiet = 4
  const size = (symbol.pixx + quiet * 2) * scale
  const left = Math.floor((width - size) / 2)
  const top = Math.floor((height - size) / 2)
  const luma = Buffer.alloc(width * height, 235)
  for (let y = 0; y < symbol.pixy; y++) {
    for (let x = 0; x < symbol.pixx; x++) {
      if (!symbol.pixs[y * symbol.pixx + x]) continue
      for (let dy = 0; dy < scale; dy++) {
        const row = top + (y + quiet) * scale + dy
        luma.fill(16, row * width + left + (x + quiet) * scale, row * width + left + (x + quiet + 1) * scale)
      }
    }
  }
  const chroma = Buffer.alloc((width / 2) * (height / 2) * 2, 128)
  writeFileSync(
    file,
    Buffer.concat([
      Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420jpeg\n`),
      Buffer.from("FRAME\n"),
      luma,
      chroma,
    ])
  )
  return file
}

// The same browser the suite's config picks, with the fake camera added.
const preinstalled = "/opt/pw-browsers/chromium"
const executablePath = existsSync(chromium.executablePath())
  ? undefined
  : existsSync(preinstalled)
    ? preinstalled
    : undefined

test.use({
  launchOptions: {
    ...(executablePath ? { executablePath } : {}),
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-video-capture=${fakeCamera(CHARIZARD.encoded)}`,
    ],
  },
  permissions: ["camera"],
})

async function signIn(page: Page) {
  await page.goto("/login?demo=1")
  await page.getByLabel("Email").fill(DEMO_EMAIL)
  await page.getByLabel("Password").fill(DEMO_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()
}

/** The camera on the Scan screen reads the label and opens the item. */
async function scanWithCamera(page: Page) {
  await page.goto("/counter/scan")
  await page.getByRole("button", { name: "Use camera" }).click()
  await expect(page.getByLabel("Camera viewfinder")).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/counter/stock/${CHARIZARD.encoded}$`), { timeout: 20_000 })
  await expect(page.getByTestId("item-sku")).toHaveText(CHARIZARD.display)
}

/** A scanner's burst, delivered inside the page in one go, as a scanner does. */
async function wedge(page: Page, text: string) {
  await page.evaluate((keys) => {
    const target = document.activeElement ?? document.body
    for (const key of [...keys, "Enter"]) {
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
      target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }))
    }
  }, text)
}

test.describe("barcode scanning", () => {
  test("the camera reads a label with zxing-wasm, served from the app (Safari on the Mac)", async ({ page }) => {
    const wasm: string[] = []
    page.on("request", (request) => {
      if (request.url().endsWith(".wasm")) wasm.push(request.url())
    })
    await signIn(page)
    await scanWithCamera(page)
    expect(wasm.length).toBeGreaterThan(0)
    for (const url of wasm) expect(new URL(url).origin).toBe(new URL(page.url()).origin)
  })

  test("a BarcodeDetector that reads no QR codes hands over to zxing (a tablet without the module)", async ({ page }) => {
    await page.addInitScript(() => {
      class NoQrDetector {
        static async getSupportedFormats() {
          return [] as string[]
        }
        async detect() {
          return [] as { rawValue: string }[]
        }
      }
      Object.defineProperty(window, "BarcodeDetector", { value: NoQrDetector, configurable: true })
    })
    await signIn(page)
    await scanWithCamera(page)
  })

  test("a BarcodeDetector that reads QR codes is used (Chrome on the tablet and the Mac)", async ({ page }) => {
    await page.addInitScript((code) => {
      const calls = { detect: 0 }
      ;(window as unknown as { __detector: typeof calls }).__detector = calls
      class NativeDetector {
        static async getSupportedFormats() {
          return ["qr_code", "ean_13", "ean_8", "upc_e", "code_128"]
        }
        async detect() {
          calls.detect += 1
          return [{ rawValue: code }]
        }
      }
      Object.defineProperty(window, "BarcodeDetector", { value: NativeDetector, configurable: true })
    }, CHARIZARD.encoded)
    await signIn(page)
    await scanWithCamera(page)
  })

  test("the webcam takes an item photo inside the capture guide (the Mac)", async ({ page }) => {
    await signIn(page)
    await page.goto(`/counter/stock/${CHARIZARD.encoded}`)
    await page.getByTestId("item-photos").getByRole("button", { name: "Take photo" }).click()
    const sheet = page.getByTestId("photo-sheet")
    await expect(sheet.getByTestId("photo-guide")).toBeVisible()
    await sheet.getByRole("button", { name: "Take photo" }).click()
    const review = sheet.getByTestId("photo-review")
    await expect(review).toBeVisible()
    // The fake camera is 640 x 480; the guide is 86 percent of the largest
    // 63:88 frame in it, and what is inside the guide is what is kept.
    await expect
      .poll(() => review.evaluate((image: HTMLImageElement) => `${image.naturalWidth}x${image.naturalHeight}`))
      .toBe("296x413")
    await sheet.getByRole("button", { name: "Save photo" }).click()
    await expect(sheet).toBeHidden()
    await expect(page.getByTestId("item-photo")).toHaveCount(1)
  })

  test("a keyboard-wedge scanner opens the item from any screen, prefix or not", async ({ page }) => {
    await signIn(page)
    await wedge(page, CHARIZARD.encoded)
    await expect(page).toHaveURL(new RegExp(`/counter/stock/${CHARIZARD.encoded}$`))
    await expect(page.getByTestId("item-sku")).toHaveText(CHARIZARD.display)

    // A scanner still set up with a prefix character.
    const mabel = buildCode("single", "T4M9P")
    await wedge(page, `~${mabel.encoded}`)
    await expect(page).toHaveURL(new RegExp(`/counter/stock/${mabel.encoded}$`))
  })
})
