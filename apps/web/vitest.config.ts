import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

/**
 * Unit tests only: no router plugin, no Tailwind, no PWA. The browser-facing
 * build lives in vite.config.ts; keeping the two apart stops the route-tree
 * generator from running on every `vitest run`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
})
