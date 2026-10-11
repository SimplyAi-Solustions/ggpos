/**
 * Puts the rendered tutorials into the counter's Tutorials page
 * (apps/web/src/features/tutorials):
 *
 * - copies each upload-sized video from out/share/ into
 *   apps/web/public/tutorials/, where the app serves it from;
 * - takes a still from its title card for the poster;
 * - writes catalogue.gen.ts: each video's title, length, chapters and steps,
 *   timed from the same layout the video was rendered from, so a chapter
 *   button lands on that chapter's card.
 *
 *   npm run render && npm run share   first, so out/share/ is current
 *   npm run publish-to-app
 *
 * Each address carries a version (?v=) taken from the video's own contents:
 * after a re-render a browser fetches the new file, and otherwise it keeps
 * the one it has.
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { FPS, layout } from "./src/timing.ts"

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, "..")
const bin = join(here, "node_modules", "@remotion", "compositor-linux-x64-gnu")
const env = { ...process.env, LD_LIBRARY_PATH: bin }
const publicDir = join(repo, "apps", "web", "public", "tutorials")
const catalogue = join(repo, "apps", "web", "src", "features", "tutorials", "catalogue.gen.ts")

const seconds = (frames) => Math.round((frames / FPS) * 100) / 100
const hashOf = (file) => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12)

const manifests = readdirSync(join(here, "src", "captures"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(here, "src", "captures", f), "utf8")))
  .sort((a, b) => a.number - b.number)

mkdirSync(publicDir, { recursive: true })
const keep = new Set()
const tutorials = []

for (const m of manifests) {
  const id = `${String(m.number).padStart(2, "0")}-${m.slug}`
  const video = join(here, "out", "share", `${id}.mp4`)
  if (!existsSync(video)) {
    throw new Error(`out/share/${id}.mp4 is missing. Run npm run render and npm run share first.`)
  }
  const version = hashOf(video)
  const target = join(publicDir, `${id}.mp4`)
  if (!existsSync(target) || hashOf(target) !== version) copyFileSync(video, target)
  // The title card is fully in by 3.6 seconds.
  execFileSync(
    join(bin, "ffmpeg"),
    ["-v", "error", "-y", "-ss", "3.6", "-i", video, "-frames:v", "1", "-vf", "scale=1280:-2", "-q:v", "3", join(publicDir, `${id}.jpg`)],
    { env }
  )
  keep.add(`${id}.mp4`).add(`${id}.jpg`)

  const { segments, total } = layout(m)
  const chapters = []
  for (const seg of segments) {
    if (seg.kind === "section") chapters.push({ title: seg.title, start: seconds(seg.from), steps: [] })
    if (seg.kind === "step" && seg.step) {
      if (!chapters.length) chapters.push({ title: "Start", start: seconds(seg.from), steps: [] })
      chapters[chapters.length - 1].steps.push({ caption: seg.step.caption, start: seconds(seg.from) })
    }
  }
  tutorials.push({
    slug: m.slug,
    number: m.number,
    title: m.title,
    subtitle: m.subtitle,
    video: `/tutorials/${id}.mp4?v=${version}`,
    poster: `/tutorials/${id}.jpg?v=${version}`,
    duration: seconds(total),
    chapters,
  })
  console.log(`${id}: ${chapters.length} chapters, ${seconds(total)}s`)
}

// A video that is no longer rendered leaves the app too.
for (const file of readdirSync(publicDir)) {
  if (!keep.has(file)) rmSync(join(publicDir, file))
}

/** JSON with bare keys, so the file reads like the rest of the app's code. */
function literal(value, indent = "") {
  const inner = `${indent}  `
  if (Array.isArray(value)) {
    if (!value.length) return "[]"
    return `[\n${value.map((v) => `${inner}${literal(v, inner)},`).join("\n")}\n${indent}]`
  }
  if (value && typeof value === "object") {
    const lines = Object.entries(value).map(([k, v]) => `${inner}${k}: ${literal(v, inner)},`)
    return `{\n${lines.join("\n")}\n${indent}}`
  }
  return JSON.stringify(value)
}

writeFileSync(
  catalogue,
  [
    "// Written by videos/publish-to-app.mjs from the rendered tutorials. Do not edit by hand:",
    "// change the capture script in videos/capture/tutorials, render, and publish again.",
    'import type { Tutorial } from "./types"',
    "",
    `export const TUTORIALS: Tutorial[] = ${literal(tutorials)}`,
    "",
  ].join("\n")
)
try {
  execFileSync("pnpm", ["exec", "prettier", "--write", catalogue], { cwd: repo, stdio: "ignore" })
} catch {
  // Prettier is a nicety here; the file is valid either way.
}
console.log(`Wrote ${tutorials.length} tutorials to apps/web/src/features/tutorials/catalogue.gen.ts`)
