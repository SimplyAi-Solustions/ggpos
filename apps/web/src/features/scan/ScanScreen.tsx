import * as React from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { FieldError } from "@/components/ui/field"
import { BarcodeGlyph, Input } from "@/components/ui/input"
import { Hint, MicroLabel } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { ProductImage } from "@/components/product-image"
import { Skeleton } from "@/components/ui/skeleton"
import { registerScanField } from "@/app/focus-registry"
import { applyScanOutcome, setScanHandler } from "@/app/scan-bus"
import { CameraSheet } from "@/features/scan/CameraSheet"
import { PriceCheck } from "@/features/scan/PriceCheck"
import {
  recordScan,
  useRecentScans,
  type RecentScan,
} from "@/features/scan/recent-scans"
import { routeScannedCode } from "@/lib/scanning/route-code"
import { searchCards } from "@/lib/api/lookup"
import { LOOKUP_STALE_MS } from "@/lib/api/prices"
import type { CardHit } from "@/lib/api"

/** The arrow that follows "PRESS ENTER" in the reference. */
function EnterArrow() {
  return (
    <svg viewBox="0 0 24 12" className="h-2.5 w-6" aria-hidden="true">
      <path d="M0 6h22M17 1l5 5-5 5" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  )
}

/** Panels own the pointer while they are open; the field must not fight them. */
const KEEPS_FOCUS =
  "input, textarea, select, button, a, [contenteditable='true'], [role='dialog'], [role='menu'], [data-slot='sheet-content'], [data-slot='dialog-content'], [data-slot='select-content'], [data-slot='menu-content']"

const ROW = "flex min-h-12 items-center gap-4"
const ROW_LINK = `${ROW} transition-colors duration-150 ease-gg hover:bg-row-hover`

function RecentRow({ scan }: { scan: RecentScan }) {
  const body = (
    <>
      <span className="tnum min-w-0 flex-1 truncate font-mono text-[13px] text-foreground">
        {scan.display}
      </span>
      <Hint className="shrink-0">{scan.kind}</Hint>
    </>
  )
  return (
    <li className="border-b border-hairline-soft">
      {scan.sku ? (
        <Link to="/counter/stock/$sku" params={{ sku: scan.sku }} className={ROW_LINK}>
          {body}
        </Link>
      ) : scan.customerCode ? (
        <Link
          to="/counter/customers/$code"
          params={{ code: scan.customerCode }}
          className={ROW_LINK}
        >
          {body}
        </Link>
      ) : (
        <div className={ROW}>{body}</div>
      )}
    </li>
  )
}

export interface ScanScreenProps {
  /** A code handed over by another screen, shown as though it were scanned. */
  incoming?: string
}

/**
 * The counter's front door. The field is the biggest thing on the page, it
 * holds focus so a keyboard-wedge scanner needs no click, and an unrecognised
 * code says so under the field rather than in a toast that floats away.
 */
export function ScanScreen({ incoming }: ScanScreenProps) {
  const navigate = useNavigate()
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [cameraOpen, setCameraOpen] = React.useState(false)
  const recent = useRecentScans()

  const commit = React.useCallback(
    (raw: string) => {
      const trimmed = raw.trim()
      if (!trimmed) return
      const outcome = routeScannedCode(trimmed)

      if (inputRef.current) inputRef.current.value = ""

      switch (outcome.kind) {
        case "item":
          setError(null)
          recordScan({
            raw: trimmed,
            display: outcome.display,
            kind: "Item",
            sku: outcome.sku,
          })
          break
        case "customer":
          setError(null)
          recordScan({
            raw: trimmed,
            display: outcome.display,
            kind: "Customer",
            customerCode: outcome.code,
          })
          break
        case "ean":
          setError(null)
          recordScan({ raw: trimmed, display: outcome.ean, kind: "Barcode" })
          break
        case "voucher":
          setError(outcome.message)
          recordScan({ raw: trimmed, display: trimmed, kind: "Voucher" })
          return
        default:
          setError(outcome.message)
          recordScan({ raw: trimmed, display: trimmed, kind: "Not recognised" })
          return
      }

      applyScanOutcome(outcome, navigate, trimmed)
    },
    [navigate]
  )

  // Claim the global wedge listener while this screen is up, so a scan lands
  // here with its error under the field instead of routing blind.
  React.useEffect(() => setScanHandler(commit), [commit])

  // A code passed over from another screen, for example a voucher scanned on
  // the stock list, arrives through the route's search params.
  const lastIncoming = React.useRef<string | undefined>(undefined)
  React.useEffect(() => {
    if (!incoming || incoming === lastIncoming.current) return
    lastIncoming.current = incoming
    commit(incoming)
  }, [incoming, commit])

  // Focus on mount, and take it back from anything that is not a control.
  React.useEffect(() => {
    const field = inputRef.current
    if (!field) return undefined
    field.focus()
    const unregister = registerScanField(field)

    function reclaim(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest(KEEPS_FOCUS)) return
      // A sheet or dialog is open somewhere: leave its focus trap alone.
      if (document.querySelector("[data-slot='sheet-content'],[data-slot='dialog-content']"))
        return
      field?.focus()
    }

    document.addEventListener("pointerup", reclaim)
    return () => {
      document.removeEventListener("pointerup", reclaim)
      unregister()
    }
  }, [])

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Scan</PageTitle>
      <Lede>Item codes, customer cards and barcodes all land here.</Lede>

      <div className="mt-14">
        <Input
          ref={inputRef}
          size="scan"
          data-testid="scan-field"
          leadingIcon={<BarcodeGlyph />}
          trailingHint={
            <span className="inline-flex items-center gap-2">
              Press enter
              <EnterArrow />
            </span>
          }
          placeholder="Scan barcode or type here"
          aria-label="Scan a barcode or type an item code"
          aria-describedby="scan-help"
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="go"
          onChange={() => setError(null)}
        />
        <FieldError>{error}</FieldError>

        <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-8 gap-y-3">
          <p
            id="scan-help"
            className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground"
          >
            Scan a barcode or enter an item code to continue.
          </p>
          {/* At least a 48px target in the thumb zone on a phone. */}
          <Button
            variant="text"
            onClick={() => setCameraOpen(true)}
            className="max-sm:min-h-12"
          >
            Use camera
          </Button>
        </div>
      </div>

      <div className="mt-24">
        <MicroLabel tone="ink" className="mb-5">
          Recent scans
        </MicroLabel>
        {recent.length === 0 ? (
          <p className="text-[15px] leading-[1.5] text-muted-foreground-2">
            Nothing scanned yet at this till.
          </p>
        ) : (
          <ul className="border-t border-hairline-soft">
            {recent.map((scan) => (
              <RecentRow key={`${scan.at}-${scan.raw}`} scan={scan} />
            ))}
          </ul>
        )}
      </div>

      <CameraSheet
        open={cameraOpen}
        onOpenChange={setCameraOpen}
        onResult={commit}
      />
    </section>
  )
}
