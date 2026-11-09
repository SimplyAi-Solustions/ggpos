import * as React from "react"
import { Link } from "@tanstack/react-router"
import { Flashlight, FlashlightOff, ImageUp, Search, Timer, TimerOff } from "lucide-react"

import { cn } from "@/lib/cn"

import { canvasToJpeg, CHECK_WIDTH, coverCrop, cropToCanvas, fitLongEdge, openCamera, SEND_LONG_EDGE, type CameraHandle } from "./camera"
import { counterTilt, guideLine, shouldAutoCapture } from "./capture-guide"
import { createCaptureGuide, frameIssue, measureFrame, toLuma, type CaptureState, type LumaFrame } from "./capture-quality"

export interface CameraViewProps {
  onCapture: (jpegDataUrl: string) => void
  onPickFile: () => void
  /** The camera could not start: no device, or permission refused. */
  onUnavailable: (message: string) => void
}

const TICK_MS = 110

/**
 * The live viewfinder. Full screen on a phone, above the tab bar. Every tick
 * it checks the part of the frame inside the card guide (capture-quality.ts)
 * and says one line about it; the shutter, or auto-capture once the guide
 * has held green, sends the sharpest frame of the steady run.
 */
export function CameraView({ onCapture, onPickFile, onUnavailable }: CameraViewProps) {
  const boxRef = React.useRef<HTMLDivElement>(null)
  const guideRef = React.useRef<HTMLDivElement>(null)
  const videoRef = React.useRef<HTMLVideoElement>(null)
  const cameraRef = React.useRef<CameraHandle | null>(null)
  const guideStateRef = React.useRef(createCaptureGuide<HTMLCanvasElement>())
  const orientation = React.useRef<{ beta: number | null; gamma: number | null }>({ beta: null, gamma: null })
  const readySince = React.useRef<number | null>(null)
  const capturedRef = React.useRef(false)

  const [state, setState] = React.useState<CaptureState | null>(null)
  const [auto, setAuto] = React.useState(true)
  const [torch, setTorch] = React.useState<boolean | null>(null)
  const autoRef = React.useRef(auto)
  React.useEffect(() => {
    autoRef.current = auto
  }, [auto])

  const regionOf = React.useCallback(() => {
    const video = videoRef.current
    const box = boxRef.current?.getBoundingClientRect()
    const guide = guideRef.current?.getBoundingClientRect()
    if (!video || !box || !guide || !video.videoWidth) return null
    return coverCrop(
      { width: video.videoWidth, height: video.videoHeight },
      { width: box.width, height: box.height },
      { x: guide.left - box.left, y: guide.top - box.top, width: guide.width, height: guide.height }
    )
  }, [])

  const grab = React.useCallback(() => {
    const video = videoRef.current
    const region = regionOf()
    if (!video || !region) return null
    return cropToCanvas(video, region, fitLongEdge(region, SEND_LONG_EDGE))
  }, [regionOf])

  const capture = React.useCallback(() => {
    if (capturedRef.current) return
    const canvas = guideStateRef.current.bestFrame() ?? grab()
    if (!canvas) return
    capturedRef.current = true
    navigator.vibrate?.(30)
    onCapture(canvasToJpeg(canvas))
  }, [grab, onCapture])

  // Open the camera once; close it on the way out.
  React.useEffect(() => {
    let cancelled = false
    const abort = new AbortController()
    const video = videoRef.current
    if (!video) return
    openCamera(video, abort.signal)
      .then((handle) => {
        if (cancelled) {
          handle.stop()
          return
        }
        cameraRef.current = handle
        setTorch(handle.torchAvailable() ? false : null)
      })
      .catch((error: unknown) => {
        if (cancelled || abort.signal.aborted) return
        const name = (error as { name?: string })?.name
        onUnavailable(
          name === "NotAllowedError"
            ? "Camera permission was refused. Allow it in the browser settings, or upload a photo."
            : "No camera found on this device. Upload a photo of the card instead."
        )
      })
    const onOrient = (event: DeviceOrientationEvent) => {
      orientation.current = { beta: event.beta, gamma: event.gamma }
    }
    window.addEventListener("deviceorientation", onOrient)
    return () => {
      cancelled = true
      abort.abort()
      window.removeEventListener("deviceorientation", onOrient)
      cameraRef.current?.stop()
      cameraRef.current = null
    }
  }, [onUnavailable])

  // The capture-guide loop.
  React.useEffect(() => {
    const check = document.createElement("canvas")
    const ctx = check.getContext("2d", { willReadFrequently: true })
    let previous: LumaFrame | null = null
    let lastText = ""
    const timer = window.setInterval(() => {
      const video = videoRef.current
      const region = regionOf()
      if (!ctx || !video || !region || video.readyState < 2 || capturedRef.current) return
      const w = CHECK_WIDTH
      const h = Math.max(1, Math.round((region.height / region.width) * w))
      check.width = w
      check.height = h
      ctx.drawImage(video, region.x, region.y, region.width, region.height, 0, 0, w, h)
      const frame = toLuma(ctx.getImageData(0, 0, w, h).data, w, h)
      const metrics = measureFrame(frame, previous)
      previous = frame
      const tilt = counterTilt(orientation.current.beta, orientation.current.gamma)
      // Only cut the full-size crop for a frame that could be the one sent.
      const full = frameIssue(metrics, tilt) ? null : grab()
      const next = guideStateRef.current.push(metrics, tilt, full as HTMLCanvasElement)
      const now = performance.now()
      if (next.kind === "ready") readySince.current ??= now
      else readySince.current = null
      const text = guideLine(next).text + next.kind
      if (text !== lastText) {
        lastText = text
        setState(next)
      }
      if (autoRef.current && shouldAutoCapture(readySince.current, now)) capture()
    }, TICK_MS)
    return () => window.clearInterval(timer)
  }, [regionOf, grab, capture])

  const line = guideLine(state)
  const ready = line.tone === "ready"

  return (
    <div
      ref={boxRef}
      className="fixed inset-x-0 top-0 bottom-[calc(var(--tabbar-h)+var(--safe-bottom))] z-[35] overflow-hidden bg-ink text-paper md:relative md:inset-auto md:z-auto md:h-[min(72vh,760px)] md:rounded-lg"
    >
      <video ref={videoRef} muted playsInline aria-label="Camera viewfinder" className="absolute inset-0 size-full object-cover" />

      {/* Top bar. */}
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-2 bg-gradient-to-b from-ink/70 to-transparent px-4 pt-[calc(var(--safe-top)+12px)] pb-8">
        <p className="font-display text-2xl tracking-wide uppercase">Scan</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setAuto((a) => !a)}
            aria-pressed={auto}
            className="flex h-10 items-center gap-1.5 rounded-full bg-paper/12 px-3 text-sm font-medium backdrop-blur-md"
          >
            {auto ? <Timer className="size-4" aria-hidden /> : <TimerOff className="size-4" aria-hidden />}
            {auto ? "Auto" : "Manual"}
          </button>
          {torch !== null && (
            <button
              type="button"
              aria-pressed={torch}
              aria-label={torch ? "Torch off" : "Torch on"}
              onClick={() => void cameraRef.current?.setTorch(!torch).then(setTorch)}
              className="flex size-10 items-center justify-center rounded-full bg-paper/12 backdrop-blur-md"
            >
              {torch ? <Flashlight className="size-5" aria-hidden /> : <FlashlightOff className="size-5" aria-hidden />}
            </button>
          )}
        </div>
      </div>

      {/* Card guide: a 63:88 window with the rest of the frame dimmed. */}
      <div className="absolute inset-0 flex items-center justify-center pb-24">
        <div
          ref={guideRef}
          className={cn(
            "relative aspect-[63/88] w-[min(74vw,46vh,340px)] rounded-[18px] shadow-[0_0_0_200vmax_rgba(11,11,11,0.55)] transition-[box-shadow] duration-300",
            ready && "shadow-[0_0_0_200vmax_rgba(11,11,11,0.45)]"
          )}
        >
          {["top-0 left-0 border-t-[3px] border-l-[3px] rounded-tl-[18px]", "top-0 right-0 border-t-[3px] border-r-[3px] rounded-tr-[18px]", "bottom-0 left-0 border-b-[3px] border-l-[3px] rounded-bl-[18px]", "right-0 bottom-0 border-r-[3px] border-b-[3px] rounded-br-[18px]"].map((corner) => (
            <span key={corner} aria-hidden className={cn("absolute size-9 transition-colors duration-300", ready ? "border-lime" : "border-paper", corner)} />
          ))}
          <span aria-hidden className="absolute inset-x-3 bottom-[9%] border-t border-dashed border-paper/35" />
        </div>
      </div>

      {/* The guide line. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-[132px] z-10 flex justify-center px-6" aria-live="polite">
        <p
          className={cn(
            "rounded-full px-4 py-2 text-center text-[15px] font-semibold backdrop-blur-md transition-colors duration-200",
            line.tone === "ready" && "bg-lime text-ink",
            line.tone === "warn" && "bg-ink/70 text-volt",
            line.tone === "neutral" && "bg-ink/60 text-paper"
          )}
        >
          {line.text}
        </p>
      </div>

      {/* Controls. */}
      <div className="absolute inset-x-0 bottom-0 z-10 flex items-center justify-between px-8 pb-6">
        <button type="button" onClick={onPickFile} className="flex size-12 items-center justify-center rounded-full bg-paper/12 backdrop-blur-md" aria-label="Upload a photo">
          <ImageUp className="size-5" aria-hidden />
        </button>
        <button
          type="button"
          onClick={capture}
          aria-label="Take photo"
          className={cn(
            "flex size-[76px] items-center justify-center rounded-full border-4 transition-colors duration-200 active:scale-95",
            ready ? "border-lime" : "border-paper"
          )}
        >
          <span className={cn("size-[58px] rounded-full transition-colors duration-200", ready ? "bg-lime" : "bg-paper")} />
        </button>
        <Link to="/cards" className="flex size-12 items-center justify-center rounded-full bg-paper/12 backdrop-blur-md" aria-label="Search instead">
          <Search className="size-5" aria-hidden />
        </Link>
      </div>
    </div>
  )
}
