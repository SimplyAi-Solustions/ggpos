import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

/**
 * Writes dist/version.json with the commit the build came from, the same file
 * apps/web writes, so deploy/self-update.sh can keep checking what is live.
 */
function versionFile(): Plugin {
  return {
    name: "gg-version-file",
    apply: "build",
    generateBundle() {
      let commit = "unknown"
      try {
        commit = execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
          .toString()
          .trim()
      } catch {
        // Not a git checkout: the file still says when.
      }
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: `${JSON.stringify({ app: "vault", commit, built_at: new Date().toISOString() })}\n`,
      })
    },
  }
}

export default defineConfig({
  plugins: [
    versionFile(),
    tanstackRouter({
      target: "react",
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
      autoCodeSplitting: true,
      quoteStyle: "double",
      semicolons: false,
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // PocketBase serves the built app in production (same origin). In dev the
    // Vite server proxies to the local PocketBase from `pnpm pb`.
    proxy: {
      "/api": { target: "http://127.0.0.1:8091", changeOrigin: true, ws: true },
      "/_": { target: "http://127.0.0.1:8091", changeOrigin: true },
    },
  },
})
