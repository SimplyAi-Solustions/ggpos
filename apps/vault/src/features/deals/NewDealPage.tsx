import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { Handshake } from "lucide-react"

import { Button, buttonClasses, EmptyState, Skeleton } from "@/ui"

import { createDeal, explain } from "./api"

/** Makes a fresh draft on the server and opens it, so it has an id for Scan and autosave from the start. */
export function NewDealPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [error, setError] = React.useState<string | null>(null)
  const [attempt, setAttempt] = React.useState(0)
  const started = React.useRef(-1)

  React.useEffect(() => {
    if (started.current === attempt) return
    started.current = attempt
    createDeal()
      .then((draft) => {
        queryClient.setQueryData(["deals", "one", draft.id], draft)
        void queryClient.invalidateQueries({ queryKey: ["deals", "list"] })
        void navigate({ to: "/deals/$id", params: { id: draft.id }, replace: true })
      })
      .catch((err) => setError(explain(err, "The new deal was not created. Try again.")))
  }, [attempt, navigate, queryClient])

  if (error) {
    return (
      <EmptyState
        icon={<Handshake aria-hidden />}
        title="No new deal"
        action={
          <div className="flex gap-2">
            <Link to="/deals" className={buttonClasses("secondary")}>
              Back to deals
            </Link>
            <Button
              onClick={() => {
                setError(null)
                setAttempt((n) => n + 1)
              }}
            >
              Try again
            </Button>
          </div>
        }
      >
        {error}
      </EmptyState>
    )
  }

  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Starting a new deal">
      <Skeleton className="h-10 w-2/3" />
      <Skeleton className="h-20" />
    </div>
  )
}
