import * as React from "react"
import { FlashlightIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Hint } from "@/components/ui/micro-label"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  CAMERA_UNAVAILABLE,
  cameraSupport,
  createCameraScanner,
  type CameraScanner,
} from "@/lib/scanning/camera"

export interface CameraSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called once with the decoded string; the sheet closes itself. */
  onResult: (value: string) => void
}

/**
 * The phone camera as a scanner. A bottom sheet, because it is a secondary
 * action and because the viewfinder wants the thumb zone.
 */
export function CameraSheet({ open, onOpenChange, onResult }: CameraSheetProps) {
  const videoRef = React.useRef<HTMLVideoElement>(null)
  const scannerRef = React.useRef<CameraScanner | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [torch, setTorch] = React.useState(false)
  const [torchReady, setTorchReady] = React.useState(false)

  const handleResult = React.useCallback(
    (value: string) => {
      onOpenChange(false)
      onResult(value)
    },
    [onOpenChange, onResult]
  )

  React.useEffect(() => {
    if (!open) return undefined

    if (!cameraSupport().camera) {
      setError(CAMERA_UNAVAILABLE)
      return undefined
    }

    let cancelled = false
    const scanner = createCameraScanner({
      onResult: handleResult,
      onError: (message) => setError(message),
    })
    scannerRef.current = scanner

    // The sheet animates in, so the <video> is not in the DOM on this tick.
    const raf = requestAnimationFrame(() => {
      const video = videoRef.current
      if (!video || cancelled) return
      void scanner.start(video).then(() => {
        if (!cancelled) setTorchReady(scanner.torchAvailable())
      })
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      scanner.stop()
      scannerRef.current = null
      setTorch(false)
      setTorchReady(false)
      setError(null)
    }
  }, [open, handleResult])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom">
        <SheetHeader>
          <SheetTitle>Camera</SheetTitle>
          <SheetDescription>
            Hold the barcode or QR code inside the frame.
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          {error ? (
            <p className="py-6 text-[15px] leading-[1.5] text-muted-foreground">
              {error}
            </p>
          ) : (
            <>
              <div className="relative aspect-[4/3] w-full overflow-hidden rounded-[var(--radius)] border border-hairline bg-secondary">
                <video
                  ref={videoRef}
                  muted
                  playsInline
                  aria-label="Camera viewfinder"
                  className="size-full object-cover"
                />
              </div>
              <div className="mt-5 flex items-center justify-between gap-6">
                <Hint>Looking for a code</Hint>
                {torchReady ? (
                  <Button
                    variant="text"
                    onClick={() => {
                      void scannerRef.current?.toggleTorch().then((next) => {
                        if (next !== null) setTorch(next)
                      })
                    }}
                    aria-pressed={torch}
                  >
                    <FlashlightIcon aria-hidden="true" />
                    {torch ? "Torch off" : "Torch on"}
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}
