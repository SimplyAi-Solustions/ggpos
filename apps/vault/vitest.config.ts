import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

/**
 * Unit tests only: no router plugin and no Tailwind. The browser build lives
 * in vite.config.ts; keeping the two apart stops the route-tree generator from
 * running on every `vitest run`. Same shape as apps/web.
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
    setupFiles: ["./src/test-setup.ts"],
    restoreMocks: true,
  },
})
