/**
 * `/labels/print?jobs=<id>,<id>` - one label per printed page.
 *
 * The counter PC runs Chrome with `--kiosk-printing` and the T003's Windows
 * driver, so this page loads, prints and marks the jobs done with no dialog
 * in the way (docs/label-spec.md, "Printing path 1"). The WebUSB TSPL2 sender
 * is a later phase; nothing here assumes it.
 *
 * Every page is sized in millimetres through `@page`, so the print comes out
 * at the label's real size whatever the screen's dpi is.
 */
import * as React from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { toSVG } from "bwip-js/browser"

import { GMark } from "@/components/ui/wordmark"
import { getLabelJobs, markLabelJobsPrinted } from "@/lib/api"
import { labelLayout, type LabelLayout } from "@/features/labels/layout"
import type { LabelJobDetail } from "@/lib/api/types"

/** A QR at the label's own size. Black on white: thermal paper has no greys. */
function Qr({ text, sizeMm }: { text: string; sizeMm: number }) {
  const svg = React.useMemo(() => {
    try {
      return toSVG({
        bcid: "qrcode",
        text,
        scale: 4,
        padding: 0,
        monochrome: true,
      })
    } catch {
      return ""
    }
  }, [text])

  return (
    <div
      aria-hidden="true"
      data-slot="label-qr"
      style={{ width: `${sizeMm}mm`, height: `${sizeMm}mm` }}
      className="shrink-0 [&>svg]:block [&>svg]:h-full [&>svg]:w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

function Label({ layout, job }: { layout: LabelLayout; job: LabelJobDetail }) {
  const { spec } = layout
  const sleeve = layout.template === "sleeve_25x15"

  return (
    <article
      data-slot="label"
      data-template={layout.template}
      data-testid="label-page"
      style={{ width: `${spec.widthMm}mm`, height: `${spec.heightMm}mm` }}
      className="relative flex break-after-page items-center gap-[1.5mm] overflow-hidden bg-white px-[1.5mm] py-[1mm] text-black"
    >
      {sleeve ? (
        <div className="flex w-full flex-col items-center justify-center gap-[0.8mm]">
          <Qr text={layout.qrText} sizeMm={layout.qrMm} />
          <span
            className="tnum font-mono leading-none"
            style={{ fontSize: `${layout.metaMm}mm` }}
          >
            {layout.lines[0]?.text}
          </span>
        </div>
      ) : (
        <>
          <Qr text={layout.qrText} sizeMm={layout.qrMm} />
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-[0.6mm]">
            {layout.lines.map((line) => {
              if (line.role === "title") {
                return (
                  <span
                    key={line.role}
                    className="truncate font-sans leading-[1.15] font-medium"
                    style={{ fontSize: `${layout.titleMm}mm` }}
                  >
                    {line.text}
                  </span>
                )
              }
              if (line.role === "price") {
                return (
                  <span
                    key={line.role}
                    className="tnum font-display leading-none"
                    style={{ fontSize: `${layout.priceMm}mm` }}
                  >
                    {line.text}
                  </span>
                )
              }
              return (
                <span
                  key={line.role}
                  className="tnum truncate font-mono leading-none tracking-[0.08em] uppercase"
                  style={{ fontSize: `${layout.metaMm}mm` }}
                >
                  {line.text}
                </span>
              )
            })}
          </div>
          {layout.showMark ? (
            <GMark
              aria-hidden="true"
              className="absolute right-[1.2mm] bottom-[1mm] h-[2.4mm] w-auto text-black"
            />
          ) : null}
        </>
      )}
      <span className="sr-only">{`${job.title} ${job.code}`}</span>
    </article>
  )
}

export interface PrintPageProps {
  /** The `jobs` search param, a comma-separated list of label_jobs ids. */
  jobs: string
  /** `false` holds the print dialog back, for screenshots and tests. */
  autoPrint?: boolean
}

export function PrintPage({ jobs, autoPrint = true }: PrintPageProps) {
  const ids = React.useMemo(
    () => jobs.split(",").map((id) => id.trim()).filter(Boolean),
    [jobs]
  )

  const { data = [], isPending } = useQuery({
    queryKey: ["label-jobs", ids],
    queryFn: () => getLabelJobs(ids),
    enabled: ids.length > 0,
  })

  const mark = useMutation({ mutationFn: markLabelJobsPrinted })
  const markRef = React.useRef(mark.mutate)
  markRef.current = mark.mutate

  // One label per page, sized by the first job's template. A queue of mixed
  // templates is printed in one go and the driver follows the stock loaded,
  // which is why the queue screen groups by template before it sends.
  const first = data[0]
  const pageSize = first
    ? labelLayout(first).spec
    : { widthMm: 40, heightMm: 20 }

  const printed = React.useRef(false)
  React.useEffect(() => {
    if (!autoPrint || printed.current || isPending || data.length === 0) return
    printed.current = true
    const done = () => markRef.current(data.map((job) => job.id))
    window.addEventListener("afterprint", done, { once: true })
    window.print()
    return () => window.removeEventListener("afterprint", done)
  }, [autoPrint, data, isPending])

  if (ids.length === 0) {
    return (
      <main className="mx-auto w-full max-w-[1040px] px-5 pt-24 sm:px-10">
        <p className="text-base text-muted-foreground">
          No labels were named. Choose them on the label queue and print again.
        </p>
      </main>
    )
  }

  return (
    <main data-testid="label-sheet" className="bg-white">
      <style>{`@page { size: ${pageSize.widthMm}mm ${pageSize.heightMm}mm; margin: 0 }
        html, body { background: #ffffff }
        body::before { display: none }
        @media screen {
          [data-slot="label"] { outline: 1px solid rgba(11,11,11,.12); margin: 8px auto }
        }
        @media print {
          [data-slot="label"]:last-child { break-after: auto }
        }`}</style>
      {data.map((job) => (
        <Label key={job.id} job={job} layout={labelLayout(job)} />
      ))}
    </main>
  )
}
