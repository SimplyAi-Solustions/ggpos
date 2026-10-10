import { createFileRoute } from "@tanstack/react-router"

import { LabelQueueScreen } from "@/features/labels/LabelQueueScreen"

export const Route = createFileRoute("/counter/labels")({
  component: LabelQueueScreen,
})
