/**
 * Runs the Impeccable detector in browser mode over every My Vault route, at
 * both of the widths DESIGN.md is judged at.
 *
 *   VITE_DEMO_SWITCH=1 pnpm --filter web build
 *   pnpm --filter web exec vite preview --port 4173   # in one terminal
 *   node apps/web/scripts/portal-detector.mjs [baseUrl]
 *
 * Browser mode rather than the saved-HTML mode `portal-detector-snapshot.mjs`
 * uses: in file mode the `cramped-padding` rule cannot see a Tailwind `py-*`
 * class and fires on every correctly spaced row. A live URL scan has no such
 * blind spot. The bundled Chromium refuses to run as root, so IMPECCABLE_BROWSER
 * points at a wrapper that adds `--no-sandbox`; the snapshot script stays for
 * environments where no such wrapper exists.
 *
 * Signed-in routes are reached with `?demo_as=<demo customer id>`, which only
 * a demo build honours.
 */
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "..", "..", "..")
const detector = join(
  repoRoot,
  ".claude/skills/impeccable/scripts/bin/linux-x64/impeccable"
)
const baseUrl = (process.argv[2] ?? "http://127.0.0.1:4173").replace(/\/$/, "")
const browser = process.env.IMPECCABLE_BROWSER ?? "/tmp/claude-0/bin/chromium-nosandbox"

const CUSTOMER = "cust_demo_1"

/** Every portal route: signed in unless it says otherwise. */
const ROUTES = [
  ["card", "/account"],
  ["quotes", "/account/quotes"],
  ["quote", "/account/quotes/quote_demo_1"],
  ["quote-new", "/account/quotes/new"],
  ["wants", "/account/wants"],
  ["credit", "/account/credit"],
  ["trade-ins", "/account/trade-ins"],
  ["trade-in", "/account/trade-ins/trade_demo_portal"],
  ["guild", "/account/guild"],
  ["rewards", "/account/rewards"],
  ["reward", "/account/rewards/reward_booster"],
  ["reward-refused", "/account/rewards/reward_retro"],
  ["points", "/account/points"],
  ["profile", "/account/me"],
  ["notifications", "/account/notifications"],
  ["estimate", "/account/estimate"],
  ["signin", "/account", { signedOut: true }],
  ["estimate-public", "/estimate", { signedOut: true }],
  ["card-landing", "/c/demo-4k7m2-token", { signedOut: true }],
]

const VIEWPORTS = ["1440x1200", "390x844"]

let total = 0
const findings = []

for (const viewport of VIEWPORTS) {
  for (const [name, path, options = {}] of ROUTES) {
    const query = options.signedOut ? "demo=1" : `demo=1&demo_as=${CUSTOMER}`
    const url = `${baseUrl}${path}?${query}`
    const run = spawnSync(detector, ["detect", "--viewport", viewport, "--json", url], {
      encoding: "utf8",
      env: { ...process.env, IMPECCABLE_BROWSER: browser },
      maxBuffer: 32 * 1024 * 1024,
    })

    let count = 0
    let rules = []
    try {
      const parsed = JSON.parse(run.stdout || "{}")
      const list = parsed.findings ?? parsed.results ?? []
      const flat = Array.isArray(list)
        ? list.flatMap((entry) => entry.findings ?? entry)
        : []
      count = flat.length
      rules = [...new Set(flat.map((entry) => entry.rule ?? entry.id ?? "?"))]
    } catch {
      count = -1
    }

    total += Math.max(count, 0)
    findings.push({ viewport, name, count, rules })
    const label = count < 0 ? "could not parse" : `${count}`
    console.log(`${viewport}  ${name.padEnd(16)} ${label}${rules.length ? "  " + rules.join(", ") : ""}`)
    if (count > 0 || count < 0) {
      process.stderr.write(run.stderr ?? "")
    }
  }
}

console.log(`\n${total} finding${total === 1 ? "" : "s"} across ${findings.length} scans`)
process.exit(total > 0 ? 2 : 0)
