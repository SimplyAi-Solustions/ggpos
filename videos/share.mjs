/**
 * Makes upload-sized copies of the rendered tutorials in out/share/, each
 * under 30 MB so it can go through chat apps and email.
 *
 *   node share.mjs                 every video in out/
 *   node share.mjs 02-adding-stock just this one
 *
 * First the music drops to 128 kbps with the picture copied untouched. If
 * that is still too big, the picture is re-encoded a step softer at a time
 * until it fits. Uses the ffmpeg that ships with Remotion.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const bin = join(here, "node_modules", "@remotion", "compositor-linux-x64-gnu")
const env = { ...process.env, LD_LIBRARY_PATH: bin }
const LIMIT = 29.5 * 1024 * 1024

const out = join(here, "out")
const wanted = process.argv.slice(2)
mkdirSync(join(out, "share"), { recursive: true })

const ffmpeg = (args) => execFileSync(join(bin, "ffmpeg"), ["-v", "error", "-y", ...args], { env, stdio: "inherit" })
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

for (const file of readdirSync(out).filter((f) => f.endsWith(".mp4")).sort()) {
  const id = file.replace(/\.mp4$/, "")
  if (wanted.length && !wanted.includes(id)) continue
  const from = join(out, file)
  const to = join(out, "share", file)
  const audio = ["-c:a", "libfdk_aac", "-b:a", "128k", "-movflags", "+faststart"]

  ffmpeg(["-i", from, "-c:v", "copy", ...audio, to])
  for (let crf = 20; statSync(to).size > LIMIT && crf <= 28; crf += 2) {
    ffmpeg(["-i", from, "-c:v", "libx264", "-preset", "slow", "-crf", String(crf), "-pix_fmt", "yuv420p", ...audio, to])
  }
  console.log(`${file}: ${mib(statSync(from).size)} to ${mib(statSync(to).size)}`)
}
