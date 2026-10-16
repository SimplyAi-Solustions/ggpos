/**
 * Home's research line: how many requests for UK sold comps are waiting or
 * being looked at, how many were done today, and the way to the Research
 * list (docs/api-contract-launch.md, section 5). It sits under Home's
 * Waiting line, in the same hairline row shape.
 */
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import { MicroLabel } from "@/components/ui/micro-label"
import { isLive, listResearch, researchKeys, researchPollMs } from "@/lib/api/research"

function isToday(iso: string, now = new Date()): boolean {
  const date = new Date(iso)
  return (
    !Number.isNaN(date.getTime()) &&
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  )
}

export function ResearchHomeLine() {
  const filters = { status: "open,claimed,done" }
  const { data: rows = [] } = useQuery({
    queryKey: researchKeys.list(filters),
    queryFn: () => listResearch(filters),
    staleTime: 30_000,
    refetchInterval: (query) => ((query.state.data ?? []).some((row) => isLive(row)) ? researchPollMs() * 4 : false),
  })
  const waiting = rows.filter((row) => isLive(row)).length
  const doneToday = rows.filter((row) => row.status === "done" && isToday(row.done_at)).length

  return (
    <div
      data-testid="research-line"
      className="flex flex-wrap items-center gap-x-8 gap-y-3 border-b border-hairline-soft py-6"
    >
      <MicroLabel>Research</MicroLabel>
      <span className="tnum text-[15px] text-foreground">
        {waiting === 0 && doneToday === 0
          ? "No research waiting."
          : [
              waiting ? `${waiting} ${waiting === 1 ? "request" : "requests"} waiting` : "",
              doneToday ? `${doneToday} done today` : "",
            ]
              .filter(Boolean)
              .join(", ")}
      </span>
      <Button variant="text" render={<Link to="/counter/research" />}>
        Research
      </Button>
    </div>
  )
}
