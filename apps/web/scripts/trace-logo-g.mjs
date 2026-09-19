/**
 * Traces the yellow G out of src/design/brand/logo-dark.png and prints it as an
 * SVG path, so the mark in src/components/ui/wordmark.tsx has a provenance and
 * can be regenerated if the logo changes.
 *
 *   node apps/web/scripts/trace-logo-g.mjs
 *
 * It decodes the PNG in a headless Chromium canvas, masks the volt pixels,
 * chains the boundary edges into a loop and simplifies it with Douglas-Peucker.
 */
import { chromium } from "@playwright/test"
import fs from "node:fs"

const PNG = "/home/user/ggpos/apps/web/src/design/brand/logo-dark.png"

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" }).catch(() => chromium.launch())
const page = await browser.newPage()
await page.goto("about:blank")
const b64 = fs.readFileSync(PNG).toString("base64")

const result = await page.evaluate(async (b64) => {
  const img = new Image()
  img.src = "data:image/png;base64," + b64
  await img.decode()
  const c = document.createElement("canvas")
  c.width = img.width; c.height = img.height
  const ctx = c.getContext("2d")
  ctx.drawImage(img, 0, 0)
  const { data, width: W, height: H } = ctx.getImageData(0, 0, c.width, c.height)
  const mask = new Uint8Array(W * H)
  let minX = W, maxX = 0, minY = H, maxY = 0, count = 0
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4
    const r = data[i], g = data[i+1], bch = data[i+2], a = data[i+3]
    // volt yellow: high red+green, low blue, opaque
    const yellow = a > 128 && r > 180 && g > 150 && bch < 120 && (r - bch) > 90
    if (yellow) { mask[y*W+x] = 1; count++
      if (x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y }
  }
  return { mask: Array.from(mask), W, H, minX, maxX, minY, maxY, count }
}, b64)

await browser.close()

const { mask, W, H, minX, maxX, minY, maxY, count } = result
console.error(`yellow px: ${count}  bbox: ${minX},${minY} -> ${maxX},${maxY}`)
const m = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? 0 : mask[y * W + x]

// Collect directed boundary edges with yellow on the left (CCW in screen coords -> use consistent rule)
const key = (p) => p[0] + "," + p[1]
const edges = new Map() // start key -> [end]
function add(a, b) {
  const k = key(a)
  if (!edges.has(k)) edges.set(k, [])
  edges.get(k).push(b)
}
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (!m(x, y)) continue
  // top edge: neighbour above empty -> direction right->? use yellow-on-right convention: (x,y)->(x+1,y)
  if (!m(x, y - 1)) add([x, y], [x + 1, y])
  if (!m(x + 1, y)) add([x + 1, y], [x + 1, y + 1])
  if (!m(x, y + 1)) add([x + 1, y + 1], [x, y + 1])
  if (!m(x - 1, y)) add([x, y + 1], [x, y])
}

const loops = []
const used = new Set()
for (const [k, list] of edges) {
  for (let idx = 0; idx < list.length; idx++) {
    const eid = k + "|" + idx
    if (used.has(eid)) continue
    // walk
    const pts = []
    let curKey = k, curIdx = idx
    while (true) {
      const arr = edges.get(curKey)
      if (!arr || curIdx >= arr.length) break
      const id = curKey + "|" + curIdx
      if (used.has(id)) break
      used.add(id)
      const start = curKey.split(",").map(Number)
      pts.push(start)
      const next = arr[curIdx]
      const nk = key(next)
      const narr = edges.get(nk)
      if (!narr) break
      let ni = narr.findIndex((_, i) => !used.has(nk + "|" + i))
      if (ni === -1) break
      curKey = nk; curIdx = ni
      if (curKey === k) { break }
    }
    if (pts.length > 8) loops.push(pts)
  }
}
loops.sort((a, b) => b.length - a.length)
console.error("loops:", loops.map(l => l.length).slice(0, 8))

// collapse collinear, then Douglas-Peucker
function collapse(pts) {
  const out = []
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], a = pts[(i - 1 + pts.length) % pts.length], b = pts[(i + 1) % pts.length]
    const cross = (p[0]-a[0])*(b[1]-a[1]) - (p[1]-a[1])*(b[0]-a[0])
    if (cross !== 0) out.push(p)
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

const VB = 100
const scale = VB / Math.max(maxX - minX + 1, maxY - minY + 1)
const wUnits = (maxX - minX + 1) * scale
const hUnits = (maxY - minY + 1) * scale
const fmt = (n) => (Math.round(n * 100) / 100).toString()
function dpClosed(pts, eps) {
  // split at the point farthest from pts[0], run DP on each arc, rejoin
  let far = 0, fd = -1
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1])
    if (d > fd) { fd = d; far = i }
  }
  const a = dp(pts.slice(0, far + 1), eps)
  const b = dp([...pts.slice(far), pts[0]], eps)
  return [...a.slice(0, -1), ...b.slice(0, -1)]
}

const paths = loops.slice(0, 4).map(loop => {
  let pts = collapse(loop)
  pts = dpClosed(pts, 1.6)
  const d = pts.map((p, i) =>
    `${i === 0 ? "M" : "L"}${fmt((p[0] - minX) * scale)} ${fmt((p[1] - minY) * scale)}`
  ).join("") + "Z"
  return d
})
console.log(JSON.stringify({ width: fmt(wUnits), height: fmt(hUnits), paths }, null, 2))
