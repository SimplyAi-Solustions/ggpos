/**
 * The capture harness. A tutorial script drives the demo counter in a real
 * browser; before every action the harness takes a screenshot and records
 * where the action lands, so the video can move a pointer to the right spot,
 * click, and cut to the next screen.
 *
 * Output, per tutorial:
 *   public/captures/<slug>/step-NN.png   the screen before each step (2x)
 *   src/captures/<slug>.json             the steps: caption, target box, action
 *
 * Demo mode only: no real customer, sale or stock ever appears in a video.
 */
import { createRequire } from "node:module"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const VIDEOS = join(dirname(fileURLToPath(import.meta.url)), "..")
export const REPO = join(VIDEOS, "..")

const require = createRequire(join(REPO, "package.json"))
const { chromium } = require("@playwright/test")

export const DEMO_EMAIL = "demo@ggentertainment.co.uk"
export const DEMO_PASSWORD = "ggvault-demo"

/** The screen size every tutorial is captured at: the counter on the Mac. */
export const VIEWPORT = { width: 1440, height: 900 }

/**
 * Opens a browser on the demo counter and returns the page plus the step
 * recorder. `meta` is { slug, number, title, subtitle, outline: string[] }.
 */
export async function session(meta, { baseURL }) {
  const shots = join(VIDEOS, "public", "captures", meta.slug)
  rmSync(shots, { recursive: true, force: true })
  mkdirSync(shots, { recursive: true })

  // As playwright.config.ts does: Playwright's own build when it is there,
  // else the Chromium this machine ships.
  const preinstalled = "/opt/pw-browsers/chromium"
  const executablePath = existsSync(chromium.executablePath())
    ? undefined
    : existsSync(preinstalled)
      ? preinstalled
      : undefined
  const browser = await chromium.launch(executablePath ? { executablePath } : {})
  const context = await browser.newContext({
    baseURL,
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: "light",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    locale: "en-GB",
    timezoneId: "Europe/London",
  })
  // The demo's "Demo" badge in the header is for testing; staff watching a
  // tutorial would look for it on their own screen, so it is hidden.
  await context.addInitScript(() => {
    const hide = () => {
      for (const el of document.querySelectorAll('[data-slot="badge"]')) {
        if (el.textContent && el.textContent.trim() === "Demo") el.style.display = "none"
      }
    }
    new MutationObserver(hide).observe(document, { childList: true, subtree: true })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)

  const steps = []
  let section = ""

  async function settle(ms = 450) {
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForTimeout(ms)
  }

  async function shoot() {
    const image = `step-${String(steps.length + 1).padStart(2, "0")}.png`
    await page.screenshot({ path: join(shots, image), animations: "disabled", caret: "initial" })
    return image
  }

  async function boxOf(target) {
    if (!target) return null
    const box = await target.boundingBox()
    if (!box) throw new Error(`No box for the target of a step in ${meta.slug}`)
    return {
      x: Math.round(box.x),
      y: Math.round(box.y),
      w: Math.round(box.width),
      h: Math.round(box.height),
    }
  }

  /**
   * One step: shows the screen as it is, moves the pointer to `target` and
   * does `action` there.
   *
   *   action: "click" (default with a target), "type" (fills `value`),
   *           "press" (presses `value`, a key), "highlight" (draws a box,
   *           does nothing), or a function given the target to do it.
   *   zoom:   true to push in on the target while the step plays.
   *   section: starts a new chapter card before this step.
   *   then:   a function run after the action (waiting for the next screen).
   */
  async function step(caption, target = null, opts = {}) {
    if (opts.section) section = opts.section
    if (target) {
      await target.waitFor({ state: "visible" })
      await target.scrollIntoViewIfNeeded()
    }
    await settle(opts.settle ?? 450)
    const image = await shoot()
    const box = await boxOf(target)
    const action = target ? (typeof opts.action === "function" ? "click" : opts.action ?? "click") : "none"
    steps.push({
      image,
      caption,
      section: opts.section ?? null,
      chapter: section,
      target: box,
      action,
      value: action === "type" ? String(opts.value ?? "") : null,
      zoom: Boolean(opts.zoom),
      hold: opts.hold ?? null,
    })

    if (target) {
      if (typeof opts.action === "function") await opts.action(target)
      else if (action === "click") await target.click()
      else if (action === "type") await target.fill(String(opts.value ?? ""))
      else if (action === "press") await target.press(String(opts.value))
    }
    if (opts.then) await opts.then()
  }

  /** A step with no pointer: just the screen and a caption, and a box drawn round `area`. */
  async function show(caption, area = null, opts = {}) {
    await step(caption, area, { ...opts, action: area ? "highlight" : undefined })
  }

  async function signIn() {
    await page.goto("/login?demo=1")
    await page.getByLabel("Email").fill(DEMO_EMAIL)
    await page.getByLabel("Password").fill(DEMO_PASSWORD)
    await page.getByRole("button", { name: "Sign in" }).click()
    await page.getByRole("heading", { name: "Today" }).waitFor()
  }

  async function finish() {
    const manifest = { ...meta, viewport: VIEWPORT, scale: 2, steps }
    const out = join(VIDEOS, "src", "captures", `${meta.slug}.json`)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n")
    await browser.close()
    console.log(`${meta.slug}: ${steps.length} steps`)
  }

  return { page, step, show, settle, signIn, finish }
}
