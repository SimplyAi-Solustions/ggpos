/**
 * Camera scanning for the phone in a staff member's hand.
 *
 * `BarcodeDetector` where the browser has it (Chrome and Android), and
 * `zxing-wasm` everywhere else (iOS Safari). The wasm module is imported
 * dynamically so it never lands in the entry bundle and is only fetched on
 * the devices that need it.
 *
 * Nothing here throws on a device with no camera: `cameraSupport()` says so
 * first and the sheet shows a sentence instead.
 */

const BARCODE_FORMATS = [
  "qr_code",
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "code_128",
] as const

const ZXING_FORMATS = ["QRCode", "EAN-13", "EAN-8", "UPC-A", "UPC-E", "Code128"]

interface DetectedBarcode {
  rawValue: string
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource | ImageData): Promise<DetectedBarcode[]>
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: readonly string[] }): BarcodeDetectorLike
  getSupportedFormats?: () => Promise<string[]>
}

function detectorCtor(): BarcodeDetectorConstructor | null {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorConstructor })
    .BarcodeDetector
  return typeof ctor === "function" ? ctor : null
}

export interface CameraSupport {
  /** Can we ask for a camera stream at all? */
  camera: boolean
  /** Is the native decoder available, or do we load zxing-wasm? */
  nativeDecoder: boolean
}

export function cameraSupport(): CameraSupport {
  const hasMediaDevices =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  return { camera: hasMediaDevices, nativeDecoder: detectorCtor() !== null }
}

export const CAMERA_UNAVAILABLE = "Camera not available on this device"

export interface CameraScannerOptions {
  onResult: (value: string) => void
  onError?: (message: string) => void
  /** Milliseconds between decode attempts. Default 220. */
  intervalMs?: number
}

export interface CameraScanner {
  start(video: HTMLVideoElement): Promise<void>
  stop(): void
  /** Returns the torch state after the toggle, or null when unsupported. */
  toggleTorch(): Promise<boolean | null>
  torchAvailable(): boolean
}

type TorchConstraint = MediaTrackConstraintSet & { torch?: boolean }

export function createCameraScanner(options: CameraScannerOptions): CameraScanner {
  const { onResult, onError, intervalMs = 220 } = options

  let stream: MediaStream | null = null
  let timer: number | null = null
  let stopped = false
  let torchOn = false
  let canvas: HTMLCanvasElement | null = null
  let detector: BarcodeDetectorLike | null = null
  let readBarcodes:
    | ((input: ImageData, opts: Record<string, unknown>) => Promise<{ text: string }[]>)
    | null = null

  function track(): MediaStreamTrack | null {
    return stream?.getVideoTracks()[0] ?? null
  }

  function frame(video: HTMLVideoElement): ImageData | null {
    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height) return null
    canvas ??= document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext("2d", { willReadFrequently: true })
    if (!context) return null
    context.drawImage(video, 0, 0, width, height)
    return context.getImageData(0, 0, width, height)
  }

  async function decode(video: HTMLVideoElement): Promise<string | null> {
    if (detector) {
      const found = await detector.detect(video)
      return found[0]?.rawValue ?? null
    }
    const image = frame(video)
    if (!image) return null
    if (!readBarcodes) {
      const module = await import("zxing-wasm/reader")
      readBarcodes = module.readBarcodes as unknown as typeof readBarcodes
    }
    const results = await readBarcodes!(image, {
      formats: ZXING_FORMATS,
      tryHarder: true,
      maxNumberOfSymbols: 1,
    })
    return results[0]?.text || null
  }

  async function start(video: HTMLVideoElement) {
    if (!cameraSupport().camera) {
      onError?.(CAMERA_UNAVAILABLE)
      return
    }
    stopped = false
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      })
    } catch {
      onError?.("Camera permission was refused. Allow it in your browser settings.")
      return
    }
    if (stopped) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }

    video.srcObject = stream
    video.setAttribute("playsinline", "true")
    await video.play().catch(() => undefined)

    const Detector = detectorCtor()
    if (Detector) detector = new Detector({ formats: BARCODE_FORMATS })

    timer = window.setInterval(() => {
      void decode(video)
        .then((value) => {
          if (!value || stopped) return
          stopped = true
          navigator.vibrate?.(30)
          onResult(value)
        })
        .catch(() => {
          // A frame that will not decode is the normal case, not an error.
        })
    }, intervalMs)
  }

  function stop() {
    stopped = true
    if (timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
    detector = null
    torchOn = false
  }

  function torchAvailable(): boolean {
    const capabilities = track()?.getCapabilities?.() as
      | (MediaTrackCapabilities & { torch?: boolean })
      | undefined
    return capabilities?.torch === true
  }

  async function toggleTorch(): Promise<boolean | null> {
    const videoTrack = track()
    if (!videoTrack || !torchAvailable()) return null
    torchOn = !torchOn
    await videoTrack.applyConstraints({
      advanced: [{ torch: torchOn } as TorchConstraint],
    })
    return torchOn
  }

  return { start, stop, toggleTorch, torchAvailable }
}
