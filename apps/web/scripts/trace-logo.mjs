/**
 * Traces the two Gs out of src/design/brand/logo.png (the GG Entertainment
 * logo: a paper G and a volt G, each with a thick ink outline) and writes
 * everything in the app that is drawn from them:
 *
 *   src/design/brand/logo-paths.ts   the fill paths, view boxes and the
 *                                    outline width, for GGLogo and GMark
 *   public/icon.svg, icon-*.png      the PWA icons (the lockup on ink)
 *   public/favicon.svg               the volt G on ink
 *
 *   node apps/web/scripts/trace-logo.mjs
 *
 * The PNG is decoded in a headless Chromium canvas. Each G's fill is masked
 * (the largest white component, the largest volt component), its boundary
 * edges are chained into loops and simplified with Douglas-Peucker. The ink
 * outline is not traced: it is the logo's own construction, a stroke under
 * the fill, so the mark carries it as `paint-order: stroke` with a width of
 * twice the measured outline thickness (half of a centred stroke hides under
 * the fill). On an ink surface the outline merges with the background and the
 * lockup reads as the site's logo-dark, white G and volt G.
 */
import { chromium } from "@playwright/test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const PNG = path.join(ROOT, "src/design/brand/logo.png")
const OUT_TS = path.join(ROOT, "src/design/brand/logo-paths.ts")
const PUBLIC = path.join(ROOT, "public")

const INK = "#0b0b0b"
const VOLT = "#fedf01"
const PAPER = "#ffffff"

const browser = await chromium
  .launch({ executablePath: "/opt/pw-browsers/chromium" })
  .catch(() => chromium.launch())
const page = await browser.newPage()
await page.goto("about:blank")
const b64 = fs.readFileSync(PNG).toString("base64")

// 0 nothing, 1 volt, 2 white, 3 ink. Anti-aliased pixels between two classes
// fall to 0 and the boundary lands inside that one-pixel band either way.
const { cls, W, H } = await page.evaluate(async (b64) => {
  const img = new Image()
  img.src = "data:image/png;base64," + b64
  await img.decode()
  const c = document.createElement("canvas")
  c.width = img.width
  c.height = img.height
  const ctx = c.getContext("2d")
  ctx.drawImage(img, 0, 0)
  const { data, width: W, height: H } = ctx.getImageData(0, 0, c.width, c.height)
  const cls = new Array(W * H).fill(0)
  for (let i = 0; i < W * H; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3]
    if (a < 128) continue
    if (r > 180 && g > 150 && b < 120 && r - b > 90) cls[i] = 1
    else if (r > 200 && g > 200 && b > 200) cls[i] = 2
    else if (r < 90 && g < 90 && b < 90) cls[i] = 3
  }
  return { cls, W, H }
}, b64)

const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : cls[y * W + x])

/** The largest 4-connected component of one class, as a mask. */
function largestComponent(klass) {
  const seen = new Uint8Array(W * H)
  let best = null
  for (let start = 0; start < W * H; start++) {
    if (cls[start] !== klass || seen[start]) continue
    const stack = [start]
    const cells = []
    seen[start] = 1
    while (stack.length) {
      const i = stack.pop()
      cells.push(i)
      const x = i % W, y = (i - x) / W
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        const j = ny * W + nx
        if (cls[j] === klass && !seen[j]) { seen[j] = 1; stack.push(j) }
      }
    }
    if (!best || cells.length > best.length) best = cells
  }
  const mask = new Uint8Array(W * H)
  for (const i of best) mask[i] = 1
  return mask
}

function bounds(mask) {
  let minX = W, maxX = 0, minY = H, maxY = 0
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue
    const x = i % W, y = (i - x) / W
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { minX, maxX, minY, maxY }
}

/** Directed boundary edges of a mask, chained into closed loops. */
function loopsOf(mask) {
  const m = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : mask[y * W + x])
  const key = (p) => p[0] + "," + p[1]
  const edges = new Map()
  const add = (a, b) => {
    const k = key(a)
    if (!edges.has(k)) edges.set(k, [])
    edges.get(k).push(b)
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!m(x, y)) continue
      if (!m(x, y - 1)) add([x, y], [x + 1, y])
      if (!m(x + 1, y)) add([x + 1, y], [x + 1, y + 1])
      if (!m(x, y + 1)) add([x + 1, y + 1], [x, y + 1])
      if (!m(x - 1, y)) add([x, y + 1], [x, y])
    }
  }
  const loops = []
  const used = new Set()
  for (const [k, list] of edges) {
    for (let idx = 0; idx < list.length; idx++) {
      if (used.has(k + "|" + idx)) continue
      const pts = []
      let curKey = k, curIdx = idx
      for (;;) {
        const arr = edges.get(curKey)
        if (!arr || curIdx >= arr.length) break
        const id = curKey + "|" + curIdx
        if (used.has(id)) break
        used.add(id)
        pts.push(curKey.split(",").map(Number))
        const nk = key(arr[curIdx])
        const narr = edges.get(nk)
        if (!narr) break
        const ni = narr.findIndex((_, i) => !used.has(nk + "|" + i))
        if (ni === -1) break
        curKey = nk
        curIdx = ni
        if (curKey === k) break
      }
      if (pts.length > 8) loops.push(pts)
    }
  }
  return loops.sort((a, b) => b.length - a.length)
}

function collapse(pts) {
  const out = []
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], a = pts[(i - 1 + pts.length) % pts.length], b = pts[(i + 1) % pts.length]
    if ((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0]) !== 0) out.push(p)
  }
  return out.length ? out : pts
}

function dp(pts, eps) {
  if (pts.length < 3) return pts
  let maxD = 0, idx = 0
  const [x1, y1] = pts[0], [x2, y2] = pts[pts.length - 1]
  const dx = x2 - x1, dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((pts[i][0] - x1) * dy - (pts[i][1] - y1) * dx) / len
    if (d > maxD) { maxD = d; idx = i }
  }
  if (maxD > eps) return [...dp(pts.slice(0, idx + 1), eps).slice(0, -1), ...dp(pts.slice(idx), eps)]
  return [pts[0], pts[pts.length - 1]]
}

function dpClosed(pts, eps) {
  let far = 0, fd = -1
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1])
    if (d > fd) { fd = d; far = i }
  }
  const a = dp(pts.slice(0, far + 1), eps)
  const b = dp([...pts.slice(far), pts[0]], eps)
  return [...a.slice(0, -1), ...b.slice(0, -1)]
}

const EPS = 1.6 // pixels at 1254 px, well under the outline's width

const volt = largestComponent(1)
const paper = largestComponent(2)
const vb = bounds(volt)
const pb = bounds(paper)

// Outline thickness: the ink run directly above the volt G's top edge,
// sampled across its width, median.
const runs = []
for (let x = vb.minX; x <= vb.maxX; x += 7) {
  let y = vb.minY
  while (y < H && at(x, y) !== 1) y++
  if (y >= H) continue
  let top = y - 1
  while (top >= 0 && at(x, top) === 0) top-- // the anti-aliased band
  let n = 0
  while (top >= 0 && at(x, top) === 3) { n++; top-- }
  if (n) runs.push(n)
}
runs.sort((a, b) => a - b)
const thickness = runs[Math.floor(runs.length / 2)]
console.error(`volt ${JSON.stringify(vb)} paper ${JSON.stringify(pb)} outline ${thickness}px`)

const fmt = (n) => (Math.round(n * 100) / 100).toString()
const pathFor = (loops, origin, scale) =>
  loops
    .map((loop) => dpClosed(collapse(loop), EPS))
    .map(
      (pts) =>
        "M" +
        pts.map(([x, y]) => fmt((x - origin.x) * scale) + " " + fmt((y - origin.y) * scale)).join("L") +
        "Z"
    )
    .join("")

const voltLoops = loopsOf(volt)
const paperLoops = loopsOf(paper)
console.error(`loops volt ${voltLoops.map((l) => l.length)} paper ${paperLoops.map((l) => l.length)}`)

// The lockup: both fills plus the outline on every side, 100 units tall.
const lock = {
  minX: Math.min(vb.minX, pb.minX) - thickness,
  maxX: Math.max(vb.maxX, pb.maxX) + 1 + thickness,
  minY: Math.min(vb.minY, pb.minY) - thickness,
  maxY: Math.max(vb.maxY, pb.maxY) + 1 + thickness,
}
const lockScale = 100 / (lock.maxY - lock.minY)
const lockW = (lock.maxX - lock.minX) * lockScale
const lockOrigin = { x: lock.minX, y: lock.minY }
const LOGO = {
  viewBox: `0 0 ${fmt(lockW)} 100`,
  stroke: fmt(2 * thickness * lockScale),
  paper: pathFor(paperLoops, lockOrigin, lockScale),
  volt: pathFor(voltLoops, lockOrigin, lockScale),
}

// The volt G on its own, outline included, 100 units tall.
const g = {
  minX: vb.minX - thickness,
  maxX: vb.maxX + 1 + thickness,
  minY: vb.minY - thickness,
  maxY: vb.maxY + 1 + thickness,
}
const gScale = 100 / (g.maxY - g.minY)
const gW = (g.maxX - g.minX) * gScale
const G = {
  viewBox: `0 0 ${fmt(gW)} 100`,
  stroke: fmt(2 * thickness * gScale),
  d: pathFor(voltLoops, { x: g.minX, y: g.minY }, gScale),
}

fs.writeFileSync(
  OUT_TS,
  `/**
 * Generated by scripts/trace-logo.mjs from design/brand/logo.png. Do not edit
 * by hand: rerun the script when the logo changes.
 *
 * Every path is a fill. The outline is drawn as a stroke beneath the fill
 * (\`paint-order: stroke\`) at the width given here, which is twice the
 * outline's thickness because half of a centred stroke hides under the fill.
 * View boxes include the outline, so a mark sized by height shows all of it.
 */

/** The lockup: the paper G and the volt G side by side. */
export const LOGO = {
  viewBox: ${JSON.stringify(LOGO.viewBox)},
  stroke: ${LOGO.stroke},
  paper: ${JSON.stringify(LOGO.paper)},
  volt: ${JSON.stringify(LOGO.volt)},
} as const

/** The volt G on its own, for the places a lockup would not fit. */
export const G = {
  viewBox: ${JSON.stringify(G.viewBox)},
  stroke: ${G.stroke},
  d: ${JSON.stringify(G.d)},
} as const
`
)
console.error(`wrote ${path.relative(ROOT, OUT_TS)}`)

// ---------------------------------------------------------------- icons
const lockupSvg = (fillPaper, fillVolt, strokeColor, strokeW = LOGO.stroke) =>
  `<path d="${LOGO.paper}" fill="${fillPaper}" stroke="${strokeColor}" stroke-width="${strokeW}" stroke-linejoin="round" paint-order="stroke"/>` +
  `<path d="${LOGO.volt}" fill="${fillVolt}" stroke="${strokeColor}" stroke-width="${strokeW}" stroke-linejoin="round" paint-order="stroke"/>`

/** The lockup centred on a 512 ink square at `width` px. */
function iconSvg(width, label) {
  const scale = width / lockW
  const h = 100 * scale
  const x = (512 - width) / 2
  const y = (512 - h) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="${label}">
  <rect width="512" height="512" fill="${INK}"/>
  <g transform="translate(${fmt(x)} ${fmt(y)}) scale(${fmt(scale)})">
    ${lockupSvg(PAPER, VOLT, INK)}
  </g>
</svg>
`
}

// The any-purpose icon fills 78% of the square; the maskable one keeps the
// lockup inside the 80% safe circle, so 68% of the width.
fs.writeFileSync(path.join(PUBLIC, "icon.svg"), iconSvg(400, "GG Vault"))
fs.writeFileSync(path.join(PUBLIC, "icon-maskable.svg"), iconSvg(348, "GG Vault"))

// The favicon: the volt G on an ink rounded square, which still reads at 16px
// where a two-letter lockup would not.
{
  const width = 48
  const scale = width / gW
  const h = 100 * scale
  fs.writeFileSync(
    path.join(PUBLIC, "favicon.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="${INK}"/><g transform="translate(${fmt((64 - width) / 2)} ${fmt((64 - h) / 2)}) scale(${fmt(scale)})"><path d="${G.d}" fill="${VOLT}"/></g></svg>
`
  )
}
console.error("wrote public/icon.svg, icon-maskable.svg, favicon.svg")

// Raster copies for the manifest.
for (const [file, source, size] of [
  ["icon-192.png", "icon.svg", 192],
  ["icon-512.png", "icon.svg", 512],
  ["icon-maskable-512.png", "icon-maskable.svg", 512],
]) {
  const svg = fs.readFileSync(path.join(PUBLIC, source), "utf8")
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(
    `<html><body style="margin:0;background:${INK}"><img id="i" width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"></body></html>`
  )
  await page.locator("#i").screenshot({ path: path.join(PUBLIC, file), omitBackground: false })
  console.error(`wrote public/${file}`)
}

await browser.close()
