import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { VitePWA } from "vite-plugin-pwa"

import { RUNTIME_CACHES } from "./src/lib/offline/caches.ts"

/**
 * What the service worker is allowed to keep, and for how long.
 *
 * Network first everywhere: the counter is on the shop's own network almost
 * all the time, so a cached answer is the fallback and never the first
 * choice. The cache is a day old at the most, which is long enough to get
 * through a dead router and short enough that nobody prices off last week.
 *
 * docs/PLAN.md, "Core flows and rules > Offline": the stock list, customer
 * lookups and the pricing rules are the three reads that have to survive
 * without a connection.
 */
const READ_THROUGH = [
  // GET /api/vault/config: pricing rules, offer bands, loyalty and the
  // non-secret settings. Every counter screen loads it.
  { name: RUNTIME_CACHES.config, pattern: /\/api\/vault\/config(\?|$)/ },
  // The stock list and item lookups.
  {
    name: RUNTIME_CACHES.stock,
    pattern: /\/api\/collections\/(items|locations|games)\/records/,
  },
  // Customer lookups at the counter: the `customers` record only, which is
  // the name, code and contact details. `customer_private` carries the
  // address, the date of birth and the ID fields, and none of that belongs
  // in a browser cache for a day (docs/dpia.md, docs/retention-schedule.md),
  // so it is deliberately absent and a lookup that needs it fails offline.
  { name: RUNTIME_CACHES.customers, pattern: /\/api\/collections\/customers\/records/ },
].map(({ name, pattern }) => ({
  urlPattern: pattern,
  handler: "NetworkFirst" as const,
  options: {
    cacheName: name,
    networkTimeoutSeconds: 4,
    expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 },
    cacheableResponse: { statuses: [200] },
  },
}))

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // File-based routing. `autoCodeSplitting` moves every route component into
    // its own chunk, so the kit page and the counter screens never travel in
    // the entry bundle.
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
    // The PWA shell: installed on the counter PC and on staff phones, and the
    // thing that keeps the app on screen when the connection drops. Writes do
    // not go near it; they go in the IndexedDB queue in src/lib/offline.
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "icon.svg", "icon-maskable.svg"],
      manifest: {
        name: "GG Vault",
        short_name: "Vault",
        description:
          "Stock, trade-ins, customers and the GG Guild for GG Entertainment.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        lang: "en-GB",
        // The paper canvas, so the splash and the address bar match the app
        // rather than flashing white before it paints.
        background_color: "#fbfbfa",
        theme_color: "#fbfbfa",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          {
            src: "/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      },
      workbox: {
        // The shell, its fonts included: the three faces are the design
        // system, and a fallback sans on a dead connection is not GG.
        globPatterns: ["**/*.{js,css,html,svg,ico,png,webp,woff2}"],
        // The three reference screenshots are 2.4 MB of design material for
        // the kit page, which nobody opens on a phone and nobody needs
        // offline. The counter shell is what has to be installed.
        globIgnores: ["kit/**", "logo-dark.png"],
        // bwip-js is one 900 kB module that cannot be split.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        // The push and notificationclick handlers for My Vault, pulled into
        // this worker rather than registered as a second one: two workers
        // would fight over the same scope. See apps/web/public/push-sw.js.
        importScripts: ["/push-sw.js"],
        navigateFallback: "/index.html",
        // Never answer an API call or the PocketBase dashboard with the app.
        navigateFallbackDenylist: [/^\/api\//, /^\/_\//],
        runtimeCaching: READ_THROUGH,
      },
      // The dev server is the one place a stale shell would waste an hour.
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    // bwip-js ships every symbology in one 900 kB module and cannot be split
    // further. It only loads on the Guild card and the label print routes, so
    // the limit sits just above it; anything else that large still warns.
    chunkSizeWarningLimit: 950,
  },
  server: {
    // PocketBase serves the built app in production, so the browser always
    // talks to the same origin. In dev the Vite server stands in for it.
    proxy: {
      "/api": { target: "http://127.0.0.1:8091", changeOrigin: true, ws: true },
      "/_": { target: "http://127.0.0.1:8091", changeOrigin: true },
    },
  },
})
