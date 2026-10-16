// Prepends a generated-file banner to every emitted hooks module.
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const dir = new URL("../../../pb/pb_hooks/lib/shared/", import.meta.url).pathname
const banner = `// GENERATED FILE. Do not edit.
// Source: packages/shared/src. Regenerate with: pnpm --filter @gg/shared build:hooks
`
for (const name of readdirSync(dir)) {
  if (!name.endsWith(".js")) continue
  const file = join(dir, name)
  const body = readFileSync(file, "utf8")
  if (!body.startsWith("// GENERATED FILE")) writeFileSync(file, banner + body)
}
