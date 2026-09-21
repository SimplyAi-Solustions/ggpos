import { existsSync } from "node:fs"
import { defineConfig, devices, chromium } from "@playwright/test"

// The remote build environment ships one Chromium at /opt/pw-browsers/chromium.
// When Playwright's own expected build is missing, fall back to it.
const preinstalled = "/opt/pw-browsers/chromium"
const executablePath = existsSync(chromium.executablePath())
  ? undefined
  : existsSync(preinstalled)
    ? preinstalled
    : undefined

const port = Number(process.env.E2E_PORT ?? 4173)

/** `E2E_SKIP_BUILD=1` previews the existing `dist` instead of rebuilding it. */
const build = process.env.E2E_SKIP_BUILD
  ? ""
  : "VITE_DEMO_SWITCH=1 pnpm --filter web build && "

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: executablePath ? { executablePath } : undefined,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    {
      name: "phone",
      use: {
        ...devices["Pixel 7"],
        defaultBrowserType: "chromium",
        // The two widths DESIGN.md is judged at.
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: {
    // The suite drives the built app into demo mode with `?demo=1`, which a
    // production build deliberately ignores (apps/web/src/lib/api/mode.ts):
    // only a dev server or a build made with `VITE_DEMO_SWITCH=1` honours
    // the query string. So the suite builds with that flag itself rather
    // than previewing whatever `dist` happens to hold, and the shop's own
    // production build (.github/workflows/deploy.yml) never carries it.
    //
    // That build writes `apps/web/dist`, which every run on this machine
    // shares: two suites at once will pull the files out from under each
    // other and fail with 404s that look like application bugs. Run one at a
    // time, or set `E2E_SKIP_BUILD=1` on the second to preview what the
    // first one built.
    command: `${build}pnpm --filter web exec vite preview --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
