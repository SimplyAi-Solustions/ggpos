import * as React from "react"
import { Flashlight } from "lucide-react"

import { Button, Sheet } from "@/ui"

import { CAMERA_UNAVAILABLE, cameraSupport, createCameraScanner, type CameraScanner } from "./camera"

/**
 * The camera barcode reader, ported from apps/web/src/lib/scanning: the
 * native BarcodeDetector where there is one, zxing-wasm on iPhone.
 */
export function ScanSheet({ open, onClose, onResult }: { open: boolean; onClose: () => void; onResult: (value: string) => void }) {
  const video = React.useRef<HTMLVideoElement>(null)
  const scanner = React.useRef<CameraScanner | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [torch, setTorch] = React.useState(false)
  const supported = cameraSupport().camera

  React.useEffect(() => {
    if (!open || !supported) return
    let cancelled = false
    const frame = requestAnimationFrame(() => {
      if (cancelled || !video.current) return
      const next = createCameraScanner({
        onResult: (value) => {
          next.stop()
          onResult(value)
        },
        onError: (message) => setError(message),
      })
      scanner.current = next
      next.start(video.current).catch(() => setError("The camera did not start. Allow camera access, then try again."))
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      scanner.current?.stop()
      scanner.current = null
    }
  }, [open, supported, onResult])

  return (
    <Sheet open={open} onClose={onClose} title="Scan a barcode" description="Hold the barcode inside the frame.">
      {!supported ? (
        <p className="py-6 text-fg-2">{CAMERA_UNAVAILABLE}. Type the barcode instead.</p>
      ) : (
        <div className="flex flex-col gap-3 pt-1">
          <div className="relative aspect-[4/3] overflow-hidden rounded-md bg-ink">
            <video ref={video} className="size-full object-cover" playsInline muted />
            <div aria-hidden className="pointer-events-none absolute inset-x-8 top-1/2 h-24 -translate-y-1/2 rounded-md border-2 border-volt" />
          </div>
          {error && (
            <p role="alert" className="text-sm font-medium text-pop-text">
              {error}
            </p>
          )}
          <Button
            variant="secondary"
            icon={<Flashlight className="size-4" aria-hidden />}
            onClick={async () => setTorch(Boolean(await scanner.current?.toggleTorch()))}
          >
            {torch ? "Torch off" : "Torch on"}
          </Button>
        </div>
      )}
    </Sheet>
  )
}
