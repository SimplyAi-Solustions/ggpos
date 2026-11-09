#!/usr/bin/env node
/**
 * Copies the built apps into pb/pb_public, which PocketBase serves.
 *
 *   pnpm --filter vault build               # apps/vault/dist
 *   pnpm --filter web build                 # apps/web/dist (optional, for /account)
 *   pnpm --filter vault publish:pb          # this script
 *
 * Layout it produces:
 *
 *   pb_public/index.html     the vault app: /, /login, /scan, /deals...
 *   pb_public/account.html   the old app's page, served by
 *                            pb/pb_hooks/appshell.pb.js for the customer
 *                            paths (/account..., /c/..., /estimate)
 *   pb_public/assets/        both apps' hashed files side by side
 *   pb_public/sw.js          the vault's retiring worker, which removes
 *                            the old app's service worker from browsers
 *
 * The old app's own service worker files are left out on purpose: its
 * worker answers every navigation with the cached index.html, which would
 * be the vault's page and would break /account. See apps/vault/README.md.
 *
 * Flags: --no-account skips the old app even if its build exists.
 * Plain Node, no dependencies, so deploy/self-update.sh can run it.
 */
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync, renameSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "../../..")
const vaultDist = process.env.GG_VAULT_DIST ?? join(root, "apps/vault/dist")
const webDist = process.env.GG_WEB_DIST ?? join(root, "apps/web/dist")
const out = process.env.GG_PB_PUBLIC ?? join(root, "pb/pb_public")
const withAccount = !process.argv.includes("--no-account")

if (!existsSync(join(vaultDist, "index.html"))) {
  console.error(`No vault build at ${vaultDist}. Run: pnpm --filter vault build`)
  process.exit(1)
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

// The old app's service worker and its registration, never copied.
const LEGACY_SKIP = /^(sw\.js|registerSW\.js|workbox-[\w-]+\.js|version\.json)$/

let account = false
if (withAccount && existsSync(join(webDist, "index.html"))) {
  for (const name of readdirSync(webDist)) {
    if (LEGACY_SKIP.test(name)) continue
    cpSync(join(webDist, name), join(out, name), { recursive: true })
  }
  renameSync(join(out, "index.html"), join(out, "account.html"))
  // Drop the tag that would register the old worker again.
  const html = readFileSync(join(out, "account.html"), "utf8").replace(
    /<script[^>]*registerSW\.js[^>]*><\/script>/g,
    ""
  )
  writeFileSync(join(out, "account.html"), html)
  account = true
} else if (withAccount) {
  console.warn(
    `No old app build at ${webDist}: /account, /c/ and /estimate will not be served. ` +
      "Run: pnpm --filter web build, then this script again."
  )
}

// Vault last, so its index.html, favicon and sw.js win. Hashed asset names
// cannot clash in meaning: the same name is the same content.
const clashes = []
const legacyAssets = new Set(existsSync(join(out, "assets")) ? readdirSync(join(out, "assets")) : [])
for (const name of existsSync(join(vaultDist, "assets")) ? readdirSync(join(vaultDist, "assets")) : []) {
  if (legacyAssets.has(name)) clashes.push(name)
}
cpSync(vaultDist, out, { recursive: true })

console.log(`pb_public ready at ${out}`)
console.log(`  vault app:      index.html${account ? "\n  customer pages: account.html (old app)" : ""}`)
if (clashes.length) console.log(`  shared asset names (same content): ${clashes.length}`)
