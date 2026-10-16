import { createFileRoute } from "@tanstack/react-router"

import { RewardDetailScreen } from "@/features/portal/RewardDetailScreen"

function RewardDetail() {
  const { id } = Route.useParams()
  return <RewardDetailScreen id={id} />
}

export const Route = createFileRoute("/account/rewards/$id")({
  component: RewardDetail,
})
