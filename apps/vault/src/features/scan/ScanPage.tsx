import * as React from "react"
import { Link } from "@tanstack/react-router"
import { useMutation } from "@tanstack/react-query"
import { ImageUp, Search } from "lucide-react"

import { buttonClasses, Button, PageHeader } from "@/ui"
import { errorMessage } from "@/features/cards/api"

import { fileToJpeg, hasCamera } from "./camera"
import { CameraView } from "./CameraView"
import { CandidatePicker } from "./CandidatePicker"
import { identifyCard } from "./api"

export interface ScanPageProps {
  /** Set when Scan was opened from a deal: "Add to deal" adds to that one. */
  dealId?: string
}

export function ScanPage({ dealId }: ScanPageProps) {
  const [cameraProblem, setCameraProblem] = React.useState<string | null>(() =>
    hasCamera() ? null : "No camera on this device. Upload a photo of the card instead."
  )
  const [photo, setPhoto] = React.useState<string | null>(null)
  const [fileError, setFileError] = React.useState<string | null>(null)
  const fileRef = React.useRef<HTMLInputElement>(null)

  const identify = useMutation({
    mutationFn: ({ image, deep }: { image: string; deep: boolean }) => identifyCard(image, deep),
  })

  const start = React.useCallback(
    (image: string) => {
      setPhoto(image)
      identify.reset()
      identify.mutate({ image, deep: false })
    },
    // identify's functions are stable for the life of the mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const onFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return
    setFileError(null)
    try {
      start(await fileToJpeg(file))
    } catch {
      setFileError("That file could not be read as a photo. Try a JPEG or PNG.")
    }
  }

  const onUnavailable = React.useCallback((message: string) => setCameraProblem(message), [])

  const picker = (
    <input ref={fileRef} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => void onFile(e)} />
  )

  if (photo) {
    const deep = identify.variables?.deep ?? false
    return (
      <>
        {picker}
        <CandidatePicker
          photo={photo}
          result={identify.data}
          pending={identify.isPending && !deep}
          deepPending={identify.isPending && deep}
          error={identify.isError ? errorMessage(identify.error, "The card was not read. Retake the photo or search instead.") : null}
          dealId={dealId}
          onRetake={() => {
            identify.reset()
            setPhoto(null)
          }}
          onDeepDive={() => identify.mutate({ image: photo, deep: true })}
        />
      </>
    )
  }

  if (!cameraProblem) {
    return (
      <>
        {picker}
        <CameraView onCapture={start} onPickFile={() => fileRef.current?.click()} onUnavailable={onUnavailable} />
      </>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {picker}
      <PageHeader eyebrow={dealId ? "Scan into deal" : "Counter"} title="Scan">
        {cameraProblem}
      </PageHeader>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          const file = e.dataTransfer.files?.[0]
          if (file) void fileToJpeg(file).then(start, () => setFileError("That file could not be read as a photo. Try a JPEG or PNG."))
        }}
        className="group flex flex-col items-center justify-center gap-4 rounded-lg border-2 border-dashed border-line-2 bg-panel-2 px-6 py-14 text-center transition-colors hover:border-fg-3"
      >
        <span className="relative flex aspect-[63/88] w-28 items-center justify-center rounded-[10px] border border-line-2 bg-panel shadow-panel">
          <ImageUp className="size-8 text-fg-2 transition-transform group-hover:-translate-y-0.5" aria-hidden />
        </span>
        <span className="flex flex-col gap-1">
          <span className="text-base font-semibold text-fg">Upload a photo of the card</span>
          <span className="text-sm text-fg-3">Drop it here, or choose one. Front of the card, whole card in shot.</span>
        </span>
      </button>
      {fileError && (
        <p role="alert" className="text-sm font-medium text-pop-text">
          {fileError}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2 sm:flex">
        <Button icon={<ImageUp className="size-5" aria-hidden />} onClick={() => fileRef.current?.click()}>
          Choose photo
        </Button>
        <Link to="/cards" className={buttonClasses("secondary", "md")}>
          <Search className="size-5" aria-hidden />
          Search instead
        </Link>
      </div>
    </div>
  )
}
