import path from "path"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

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
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
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
