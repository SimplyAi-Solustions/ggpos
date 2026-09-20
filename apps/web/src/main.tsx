import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { createRouter, RouterProvider } from "@tanstack/react-router"

import "./index.css"
import { routeTree } from "./routeTree.gen"
import { resolveDataMode } from "@/lib/api/mode"

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

/**
 * Work out whether this is a live counter or the demo before the first paint,
 * so no screen ever swaps data source underneath itself.
 */
async function start() {
  await resolveDataMode()
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>
  )
}

void start()
