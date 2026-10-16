/**
 * Renders every tutorial (or the ones named) to out/NN-slug.mp4.
 *
 *   node render.mjs                 every tutorial
 *   node render.mjs 03-selling      just this one
 *
 * Uses the headless Chrome this machine ships when Remotion's own is not
 * there, so nothing has to be downloaded.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const shell = "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell"

const ids = readdirSync(join(here, "src", "captures"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(here, "src", "captures", f), "utf8")))
  .sort((a, b) => a.number - b.number)
  .map((m) => `${String(m.number).padStart(2, "0")}-${m.slug}`)

const wanted = process.argv.slice(2)
mkdirSync(join(here, "out"), { recursive: true })
for (const id of ids.filter((id) => !wanted.length || wanted.includes(id))) {
  const args = ["remotion", "render", "src/index.ts", id, `out/${id}.mp4`, "--log=error"]
  if (existsSync(shell)) args.push(`--browser-executable=${shell}`)
  console.log(`rendering ${id}`)
  execFileSync("npx", args, { cwd: here, stdio: "inherit" })
}
