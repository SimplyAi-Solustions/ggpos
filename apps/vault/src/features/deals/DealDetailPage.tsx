import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Handshake } from "lucide-react"

import { Button, buttonClasses, EmptyState, Skeleton } from "@/ui"

import { explain, getDeal } from "./api"
import { CompletedDeal } from "./CompletedDeal"
import { DealBuilder, type AddFromScan } from "./DealBuilder"

export function DealDetailPage({ id, addFromScan }: { id: string; addFromScan?: AddFromScan }) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ["deals", "one", id],
    queryFn: () => getDeal(id),
    // The builder owns the draft once it is open; a refetch must not reset it.
    staleTime: Infinity,
    gcTime: 0,
    refetchOnMount: "always",
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
        title={query.isError ? "Deal did not load" : "Deal not found"}
        action={
          <div className="flex gap-2">
            <Link to="/deals" className={buttonClasses("secondary")}>
              Back to deals
            </Link>
            {query.isError && <Button onClick={() => void query.refetch()}>Try again</Button>}
          </div>
        }
      >
        {query.isError
          ? explain(query.error, "The deal did not load. Try again.")
          : "It may have been deleted. Check the deals list or start a new one."}
      </EmptyState>
    )
  }

  if (query.data.status === "completed") return <CompletedDeal deal={query.data} />
  return (
    <DealBuilder
      key={query.data.id}
      initial={query.data}
      addFromScan={addFromScan}
      onCompleted={() => {
        void queryClient.invalidateQueries({ queryKey: ["deals"] })
      }}
    />
  )
}
