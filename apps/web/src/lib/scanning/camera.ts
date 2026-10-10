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
 *
 * Launch checks (docs/api-contract-launch.md, section 6; deploy/README.md,
 * "Barcode scanners"): the Android tablet's Chrome and Chrome on the Mac have
 * `BarcodeDetector`, Safari on the Mac does not and takes zxing-wasm. So:
 * - the wasm is served from this origin, not the jsDelivr address the
 *   package defaults to, which the site's Content-Security-Policy refuses
 *   (and which is not there when the shop's connection is down);
 * - the native detector is only used when this device says it reads QR
 *   codes (`getSupportedFormats`): a tablet without the Play services
 *   barcode module has the class but reads nothing, and silently never
 *   scanning is worse than the fallback; a detector that throws hands over
 *   to zxing on the next frame;
 * - one frame is decoded at a time, so a slow device never queues them up.
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

/**
 * The formats to ask the native detector for, from what this device says it
 * reads, or null when it cannot read a QR code (every GG label is one) and
 * zxing should do the work instead.
 */
export function nativeFormats(supported: readonly string[] | null | undefined): string[] | null {
  if (!supported || !supported.includes("qr_code")) return null
  return BARCODE_FORMATS.filter((format) => supported.includes(format))
}

async function nativeDetector(ctor: BarcodeDetectorConstructor): Promise<BarcodeDetectorLike | null> {
  try {
    const supported = ctor.getSupportedFormats ? await ctor.getSupportedFormats() : [...BARCODE_FORMATS]
    const formats = nativeFormats(supported)
    return formats ? new ctor({ formats }) : null
  } catch {
    return null
  }
}

/** zxing-wasm's reader, with its wasm fetched from this origin. Loaded once. */
type ReadBarcodes = (input: ImageData, opts: Record<string, unknown>) => Promise<{ text: string }[]>
let zxingReader: Promise<ReadBarcodes> | null = null

function loadZxing(): Promise<ReadBarcodes> {
  zxingReader ??= Promise.all([
    import("zxing-wasm/reader"),
    import("zxing-wasm/reader/zxing_reader.wasm?url"),
  ]).then(([module, wasm]) => {
    module.prepareZXingModule({
      overrides: {
        locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasm.default : prefix + path),
      },
    })
    return module.readBarcodes as unknown as ReadBarcodes
  })
  zxingReader.catch(() => {
    zxingReader = null
  })
  return zxingReader
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
  let busy = false

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
      try {
        const found = await detector.detect(video)
        return found[0]?.rawValue ?? null
      } catch {
        // The native reader is there but will not work on this device:
        // zxing reads the next frame.
        detector = null
        return null
      }
    }
    const image = frame(video)
    if (!image) return null
    const readBarcodes = await loadZxing()
    const results = await readBarcodes(image, {
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
    detector = Detector ? await nativeDetector(Detector) : null
    // Fetch the fallback while the first frames arrive, not on the first frame.
    if (!detector) void loadZxing().catch(() => undefined)
    if (stopped) return

    timer = window.setInterval(() => {
      if (busy || stopped) return
      busy = true
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
        .finally(() => {
          busy = false
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
