import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClientProvider } from "@tanstack/react-query"
import { createRouter, RouterProvider } from "@tanstack/react-router"

import "./index.css"
import { routeTree } from "./routeTree.gen"
import { pb } from "@/lib/pb"
import { queryClient } from "@/lib/query"
import { applyTheme, watchSystemTheme } from "@/lib/theme"
import { ToastProvider } from "@/ui"

// public/theme-init.js has already set the class; this keeps it in step.
applyTheme()
watchSystemTheme()

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

// A sign-out anywhere (or a token the server refuses) sends the guard round again.
pb.authStore.onChange(() => {
  void router.invalidate()
}, false)

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>
)
