/**
 * Take photo (docs/api-contract-launch.md, section 6): on the item page and
 * after Add stock saves.
 *
 * Three ways to a picture, one result:
 * - **The live camera** with the capture guide: the tablet's rear camera, or
 *   the Mac's webcam. The guide is the item's frame drawn over the picture;
 *   what is inside it is what is kept.
 * - **The camera app** (`capture="environment"`), on a touch device: the
 *   tablet's own camera, full resolution.
 * - **A file**, on either.
 *
 * Whichever it was, the picture is cropped to the frame, downscaled to
 * 1600px and re-encoded in the browser (`crop.ts`), shown once to check, and
 * only then added to `items.photos`. The first photo is the one the website
 * shows.
 */
import * as React from "react"

import { Button } from "@/components/ui/button"
import { Hint } from "@/components/ui/micro-label"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { cropToFrame, GUIDE_SCALE, guideBox, itemPhotoName, type Ratio } from "@/features/photos/crop"
import { addItemPhoto, photoFrame, type PhotoFrame } from "@/lib/api/online"
import { refusalOrFallback } from "@/lib/api/refusal"
import type { StockItemRecord } from "@/lib/api/types"

type Subject = Pick<StockItemRecord, "id" | "sku" | "kind" | "retro_title">

interface Taken {
  blob: Blob
  dataUrl: string
}

/** A device whose main pointer is a finger: the tablet, a phone. */
function touchDevice(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true
}

function cameraAvailable(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function"
}

/** The live camera, for as long as `active` holds. */
function useLiveCamera(video: React.RefObject<HTMLVideoElement | null>, active: boolean) {
  const [size, setSize] = React.useState<{ width: number; height: number } | null>(null)
  const [failure, setFailure] = React.useState<string | null>(null)
  const [available] = React.useState(cameraAvailable)

  React.useEffect(() => {
    if (!active || !available) return undefined
    // No viewfinder on screen (the camera already failed once): files only.
    const element = video.current
    if (!element) return undefined
    let stream: MediaStream | null = null
    let stopped = false
    navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      })
      .then(async (next) => {
        if (stopped) {
          next.getTracks().forEach((track) => track.stop())
          return
        }
        stream = next
        setFailure(null)
        element.srcObject = next
        element.setAttribute("playsinline", "true")
        element.onloadedmetadata = () => setSize({ width: element.videoWidth, height: element.videoHeight })
        await element.play().catch(() => undefined)
        if (element.videoWidth) setSize({ width: element.videoWidth, height: element.videoHeight })
      })
      .catch((reason: unknown) => {
        if (stopped) return
        const name = reason instanceof DOMException ? reason.name : ""
        setFailure(
          name === "NotAllowedError" || name === "SecurityError"
            ? "The camera was not allowed. Allow it in the browser's settings, or choose a file."
            : "There is no camera here. Choose a file instead."
        )
      })
    return () => {
      stopped = true
      stream?.getTracks().forEach((track) => track.stop())
      element.srcObject = null
    }
  }, [active, available, video])

  return { size, error: available ? failure : "There is no camera here. Choose a file instead." }
}

/** The frame over the live picture, laid out in percentages of it. */
function Guide({ size, ratio }: { size: { width: number; height: number }; ratio: Ratio }) {
  const box = guideBox(size, ratio, GUIDE_SCALE)
  return (
    <div
      aria-hidden="true"
      data-testid="photo-guide"
      className="pointer-events-none absolute border-2 border-gg-paper outline outline-1 outline-[rgba(11,11,11,0.6)]"
      style={{
        left: `${box.x * 100}%`,
        top: `${box.y * 100}%`,
        width: `${box.width * 100}%`,
        height: `${box.height * 100}%`,
      }}
    />
  )
}

function PhotoForm({
  item,
  frame,
  onSaved,
  onCancel,
}: {
  item: Subject
  frame: PhotoFrame
  onSaved: (names: string[]) => void
  onCancel: () => void
}) {
  const videoRef = React.useRef<HTMLVideoElement>(null)
  const fileRef = React.useRef<HTMLInputElement>(null)
  const appRef = React.useRef<HTMLInputElement>(null)
  const [taken, setTaken] = React.useState<Taken | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [touch] = React.useState(touchDevice)
  const camera = useLiveCamera(videoRef, taken === null)

  async function keep(run: () => Promise<{ blob: Blob; dataUrl: string }>) {
    setBusy(true)
    setError(null)
    try {
      const result = await run()
      setTaken({ blob: result.blob, dataUrl: result.dataUrl })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That photo could not be read. Take it again.")
    } finally {
      setBusy(false)
    }
  }

  function fromFile(file: File | undefined) {
    if (!file) return
    void keep(() => cropToFrame(file, { ratio: frame.ratio }))
  }

  function fromCamera() {
    const video = videoRef.current
    if (!video || !video.videoWidth) return
    void keep(() =>
      cropToFrame(
        { source: video, width: video.videoWidth, height: video.videoHeight },
        { ratio: frame.ratio, scale: GUIDE_SCALE }
      )
    )
  }

  async function save() {
    if (!taken) return
    setSaving(true)
    setError(null)
    try {
      const names = await addItemPhoto(item.id, taken.blob, itemPhotoName(item.sku))
      onSaved(names)
    } catch (reason) {
      setError(refusalOrFallback(reason, "That photo did not save. Check the connection and try again."))
      setSaving(false)
    }
  }

  const live = taken === null && !camera.error

  return (
    <>
      <SheetBody>
        {taken ? (
          <div className="flex justify-center">
            <img
              src={taken.dataUrl}
              alt="The photo just taken, cropped to the frame"
              data-testid="photo-review"
              className="max-h-[52vh] w-auto border border-product-edge"
            />
          </div>
        ) : camera.error ? (
          <p data-testid="photo-camera-note" className="py-4 text-[15px] leading-[1.5] text-muted-foreground">
            {camera.error}
          </p>
        ) : (
          <div
            className="relative mx-auto w-full max-w-[640px] overflow-hidden border border-hairline bg-secondary"
            style={{ aspectRatio: camera.size ? `${camera.size.width} / ${camera.size.height}` : "4 / 3" }}
          >
            <video
              ref={videoRef}
              muted
              playsInline
              aria-label="Camera viewfinder"
              className="size-full object-cover"
            />
            {camera.size ? <Guide size={camera.size} ratio={frame.ratio} /> : null}
          </div>
        )}

        {live ? (
          <p className="mt-4 text-[15px] leading-[1.5] text-muted-foreground">
            Plain background, straight on, fill the frame.
          </p>
        ) : null}

        <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-3">
          {taken ? (
            <Button variant="text" onClick={() => setTaken(null)} disabled={saving}>
              Take it again
            </Button>
          ) : (
            <>
              {touch ? (
                <Button variant="text" onClick={() => appRef.current?.click()} disabled={busy}>
                  Use the camera app
                </Button>
              ) : null}
              <Button variant="text" onClick={() => fileRef.current?.click()} disabled={busy}>
                Choose a file
              </Button>
            </>
          )}
          <Button variant="text" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        </div>

        <input
          ref={appRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          data-testid="photo-camera-input"
          onChange={(event) => {
            fromFile(event.target.files?.[0])
            event.target.value = ""
          }}
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/*"
          hidden
          data-testid="photo-file-input"
          onChange={(event) => {
            fromFile(event.target.files?.[0])
            event.target.value = ""
          }}
        />

        {busy ? <Hint className="mt-4 block">Cropping the photo</Hint> : null}
        {error ? (
          <p role="alert" className="mt-4 max-w-[56ch] text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
        <p className="mt-4 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
          Cropped to its frame ({frame.label}), resized to 1600px and re-encoded, so no location
          data is kept.
        </p>
      </SheetBody>
      <SheetFooter>
        {taken ? (
          <Button loading={saving} trailingArrow onClick={() => void save()}>
            Save photo
          </Button>
        ) : (
          <Button trailingArrow disabled={!camera.size || busy || Boolean(camera.error)} onClick={fromCamera}>
            Take photo
          </Button>
        )}
      </SheetFooter>
    </>
  )
}

export function PhotoSheet({
  open,
  onOpenChange,
  item,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  item: Subject | null
  onSaved: (names: string[]) => void
}) {
  // The frame, kept with the item it was worked out for, so a sheet opened
  // on another item never crops to the last one's frame.
  const [found, setFound] = React.useState<{ id: string; frame: PhotoFrame } | null>(null)
  const frame = item && found?.id === item.id ? found.frame : null

  React.useEffect(() => {
    if (!open || !item) return undefined
    let cancelled = false
    void photoFrame(item).then((next) => {
      if (!cancelled) setFound({ id: item.id, frame: next })
    })
    return () => {
      cancelled = true
    }
  }, [open, item])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]" data-testid="photo-sheet">
        <SheetHeader>
          <SheetTitle>Take photo</SheetTitle>
          <SheetDescription>The first photo is the one the website shows.</SheetDescription>
        </SheetHeader>
        {item && frame ? (
          <PhotoForm
            item={item}
            frame={frame}
            onSaved={(names) => {
              onSaved(names)
              onOpenChange(false)
            }}
            onCancel={() => onOpenChange(false)}
          />
        ) : (
          <SheetBody>
            <Hint>Getting the frame ready</Hint>
          </SheetBody>
        )}
      </SheetContent>
    </Sheet>
  )
}
