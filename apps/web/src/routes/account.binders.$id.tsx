import { createFileRoute } from "@tanstack/react-router"

import { BinderScreen } from "@/features/binders/BinderScreen"

function BinderDetail() {
  const { id } = Route.useParams()
  return <BinderScreen key={id} id={id} />
}

export const Route = createFileRoute("/account/binders/$id")({
  component: BinderDetail,
})
