/**
 * Captures every tutorial (or the ones named): serves the demo build of the
 * counter with Vite's preview, runs each script in capture/tutorials, stops.
 *
 *   node capture/run.mjs                 every tutorial
 *   node capture/run.mjs selling stock   just these
 *
 * Needs apps/web/dist built with VITE_DEMO_SWITCH=1, so ?demo=1 works:
 *   VITE_DEMO_SWITCH=1 pnpm --filter web build
 */
import { spawn } from "node:child_process"
import { readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { REPO, VIDEOS } from "./lib.mjs"

const PORT = Number(process.env.CAPTURE_PORT ?? 4199)
const baseURL = `http://127.0.0.1:${PORT}`

const wanted = process.argv.slice(2)
const dir = join(VIDEOS, "capture", "tutorials")
const scripts = readdirSync(dir)
  .filter((f) => f.endsWith(".mjs"))
  .filter((f) => !wanted.length || wanted.some((w) => f.includes(w)))
  .sort()

const preview = spawn("pnpm", ["--filter", "web", "exec", "vite", "preview", "--port", String(PORT), "--strictPort"], {
  cwd: REPO,
  stdio: "ignore",
  detached: true,
})

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(baseURL)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`The preview did not answer on ${baseURL}`)
}

/** src/captures/index.ts: every captured tutorial, in number order, for Root.tsx. */
function writeIndex() {
  const capturesDir = join(VIDEOS, "src", "captures")
  const files = readdirSync(capturesDir).filter((f) => f.endsWith(".json")).sort()
  const names = files.map((f, i) => ({ file: f, id: `t${i}` }))
  const body = [
    "// Written by capture/run.mjs: every captured tutorial. Do not edit by hand.",
    'import type { Manifest } from "../timing"',
    ...names.map((n) => `import ${n.id} from "./${n.file}"`),
    "",
    `export const tutorials: Manifest[] = ([${names.map((n) => `${n.id} as Manifest`).join(", ")}]).sort((a, b) => a.number - b.number)`,
    "",
  ].join("\n")
  writeFileSync(join(capturesDir, "index.ts"), body)
}

let failed = false
try {
  await waitForServer()
  for (const file of scripts) {
    const mod = await import(pathToFileURL(join(dir, file)).href)
    try {
      await mod.default({ baseURL })
    } catch (err) {
      failed = true
      console.error(`${file} failed: ${err.stack ?? err}`)
    }
  }
  writeIndex()
} finally {
  try {
    process.kill(-preview.pid)
  } catch {
    preview.kill()
  }
}
process.exit(failed ? 1 : 0)
