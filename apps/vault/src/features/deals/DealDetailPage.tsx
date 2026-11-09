import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Handshake } from "lucide-react"

import { buttonClasses, EmptyState, Skeleton } from "@/ui"

import { getDeal } from "./api"
import { CompletedDeal } from "./CompletedDeal"
import { DealBuilder } from "./DealBuilder"

export function DealDetailPage({ id }: { id: string }) {
  const query = useQuery({
    queryKey: ["deals", "one", id],
    queryFn: () => getDeal(id),
    // The builder owns the draft once it is open; a refetch must not reset it.
    staleTime: Infinity,
    gcTime: 0,
  })

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-20" />
        <Skeleton className="h-48" />
      </div>
    )
  }

  if (query.isError || !query.data) {
    return (
      <EmptyState
        icon={<Handshake aria-hidden />}
        title="Deal not found"
        action={
          <Link to="/deals" className={buttonClasses("secondary")}>
            Back to deals
          </Link>
        }
      >
        Drafts are kept on the device that made them for now. Open it there, or start a new deal.
      </EmptyState>
    )
  }

  if (query.data.status === "completed") return <CompletedDeal deal={query.data} />
  return <DealBuilder key={query.data.id} initial={query.data} />
}
