import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"

import { Skeleton } from "@/ui"

import { createDraft } from "./useDealBuilder"

/** Makes a fresh draft and opens it, so it has an id for Scan and autosave from the start. */
export function NewDealPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const started = React.useRef(false)

  React.useEffect(() => {
    if (started.current) return
    started.current = true
    void createDraft().then((draft) => {
      void queryClient.invalidateQueries({ queryKey: ["deals"] })
      void navigate({ to: "/deals/$id", params: { id: draft.id }, replace: true })
    })
  }, [navigate, queryClient])

  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Starting a new deal">
      <Skeleton className="h-10 w-2/3" />
      <Skeleton className="h-20" />
    </div>
  )
}
