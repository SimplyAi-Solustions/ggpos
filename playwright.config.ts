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
    // The suite drives the built app into demo mode with `?demo=1`, so an
    // ordinary build is enough; `VITE_DEMO=1 pnpm --filter web build` pins it.
    command: `pnpm --filter web exec vite preview --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
