/**
 * Stock counts: start one, and read the ones already done.
 *
 * A count is per location. Starting one snapshots what that location is
 * recorded as holding, so the count is a record of the day rather than a
 * live query that moves while somebody is holding the scanner.
 */
import * as React from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Field } from "@/components/ui/field"
import { SectionHeading } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { StickerOrbit } from "@/components/ui/sticker"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useCounterDock } from "@/app/counter-dock"
import { refusalOrFallback } from "@/lib/api/refusal"
import {
  getOpenStockCount,
  listLocations,
  listStockCounts,
  startStockCount,
} from "@/lib/api"

const BLOCKED = "disabled:opacity-100 disabled:bg-surface-3 disabled:text-muted-foreground"

function when(iso: string): string {
  if (!iso) return ""
  const date = new Date(iso)
  return `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${date.toLocaleTimeString(
    "en-GB",
    { hour: "2-digit", minute: "2-digit" }
  )}`
}

export function StockCountStartScreen() {
  const dock = useCounterDock()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [locationId, setLocationId] = React.useState<string>("")
  const [error, setError] = React.useState<string | null>(null)

  const locations = useQuery({
    queryKey: ["locations"],
    queryFn: listLocations,
    staleTime: 5 * 60_000,
  })
  const counts = useQuery({
    queryKey: ["stock-counts"],
    queryFn: () => listStockCounts(10),
    staleTime: 30_000,
  })

  // Two counts of one shelf at once would both be wrong, so a location that
  // already has one open offers to carry on with it instead.
  const open = useQuery({
    queryKey: ["stock-count-open", locationId],
    queryFn: () => getOpenStockCount(locationId),
    enabled: locationId !== "",
    // Never cached: somebody else may have started one on the shop phone a
    // second ago, and two counts of a shelf are two wrong answers.
    staleTime: 0,
    refetchOnMount: "always",
  })
  const resume = locationId ? (open.data ?? null) : null

  const start = useMutation({
    mutationFn: () => startStockCount(locationId),
    onSuccess: (count) => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ["stock-count-open"] })
      void queryClient.invalidateQueries({ queryKey: ["stock-counts"] })
      void navigate({ to: "/counter/stock/count/$id", params: { id: count.id } })
    },
    onError: (err) =>
      setError(refusalOrFallback(err, "That count did not start. Try again.")),
  })

  const primary = resume ? (
    <Button
      className={`w-full min-[900px]:w-auto ${BLOCKED}`}
      trailingArrow
      onClick={() =>
        void navigate({
          to: "/counter/stock/count/$id",
          params: { id: resume.id },
        })
      }
    >
      Carry on counting
    </Button>
  ) : (
    <Button
      className={`w-full min-[900px]:w-auto ${BLOCKED}`}
      trailingArrow
      loading={start.isPending || open.isFetching}
      disabled={!locationId || start.isPending || open.isFetching}
      onClick={() => start.mutate()}
    >
      Start count
    </Button>
  )

  const rows = counts.data ?? []

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Stock count</PageTitle>
      <Lede>
        Take one location at a time. Scan what is on the shelf, and close it
        against what should have been.
      </Lede>

      <div className="mt-8">
        <SectionHeading>Where</SectionHeading>
        {/* The heading above says where; the chips do not need saying twice,
            and the group keeps its own accessible name. */}
        <Field layout="stacked">
          <ChipGroup
            aria-label="Location"
            value={locationId ? [locationId] : []}
            onValueChange={(next: string[]) => setLocationId(next[0] ?? "")}
          >
            {(locations.data ?? []).map((location) => (
              <Chip key={location.id} value={location.id}>
                {location.name}
              </Chip>
            ))}
          </ChipGroup>
        </Field>
        {resume ? (
          <p
            data-testid="count-resume"
            className="mt-6 max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground"
          >
            A count of {resume.locationName} is already open, started{" "}
            {when(resume.startedAt)} by {resume.startedByName}. Carry on with
            that one rather than starting a second.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-6 text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
        <div className="mt-12 hidden min-[900px]:block">{primary}</div>
      </div>

      <div className="mt-16">
        <SectionHeading>Past counts</SectionHeading>
        {rows.length === 0 ? (
          <div className="flex flex-col items-start gap-6">
            <StickerOrbit />
            <p className="max-w-[44ch] text-base leading-[1.5] text-muted-foreground">
              No location has been counted yet. Pick one above and work through
              the shelf with the scanner.
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Location</TableHead>
                <TableHead>Started</TableHead>
                <TableHead numeric>Expected</TableHead>
                <TableHead numeric>Scanned</TableHead>
                <TableHead numeric>Missing</TableHead>
                <TableHead numeric>Unexpected</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((count) => (
                <TableRow
                  key={count.id}
                  data-testid="count-row"
                  className="cursor-pointer"
                  onClick={() =>
                    void navigate({
                      to: "/counter/stock/count/$id",
                      params: { id: count.id },
                    })
                  }
                >
                  <TableCell>{count.locationName}</TableCell>
                  <TableCell className="font-mono text-[13px]">
                    {when(count.startedAt)}
                  </TableCell>
                  <TableCell numeric>{count.expected}</TableCell>
                  <TableCell numeric>{count.scanned}</TableCell>
                  <TableCell numeric>{count.missing}</TableCell>
                  <TableCell numeric>{count.unexpected}</TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {count.status === "open" ? "Open" : "Closed"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {dock
        ? createPortal(
            <div className="border-t border-hairline-soft bg-background px-5 py-3 min-[900px]:hidden">
              {primary}
            </div>,
            dock
          )
        : null}
    </section>
  )
}
