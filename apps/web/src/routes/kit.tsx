import { createFileRoute } from "@tanstack/react-router"

import { KitPage } from "@/kit/KitPage"

/** The design system on one page. Lazy, so it never rides in the app bundle. */
export const Route = createFileRoute("/kit")({
  component: KitPage,
})
