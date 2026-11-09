import * as React from "react"

import { cn } from "@/lib/cn"
import { useMediaQuery } from "@/lib/use-media"

import "./CardArt.css"

export type CardFinish = "holo" | "reverse" | "normal"

/**
 * Folds the finish strings the catalogue and stock use ("holofoil",
 * "reverseHolofoil", "Reverse holo", "1stEditionHolofoil", "normal", "")
 * into the three looks CardArt draws.
 */
export function finishKind(finish: string | null | undefined): CardFinish {
  const f = (finish ?? "").toLowerCase()
  if (f.includes("reverse")) return "reverse"
  if (f.includes("holo") || f.includes("foil") || f.includes("etched")) return "holo"
  return "normal"
}

export const FINISH_LABEL: Record<CardFinish, string> = {
  holo: "Holo",
  reverse: "Reverse holo",
  normal: "Normal",
}

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

export interface CardArtProps {
  /** The card picture. Without one the fallback sits in a card-shaped slot. */
  src?: string
  /** The accessible name, usually the card's name and number. */
  alt: string
  /** "holo", "reverse", "normal", or a raw finish string from the catalogue. */
  finish?: CardFinish | string
  /** Tilts towards the pointer or finger. On by default. */
  tilt?: boolean
  /** Also tilts with the phone (deviceorientation). iPhone asks once, on the first tap. */
  gyro?: boolean
  /** The soft colour glow behind the card, taken from the art itself. */
  glow?: boolean
  /** Shown in place of a missing or broken picture. */
  fallback?: React.ReactNode
  /** Eager loading, for the one hero card on a page. */
  priority?: boolean
  /** Largest tilt in degrees. */
  maxTilt?: number
  className?: string
}

type OrientationCtor = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<"granted" | "denied"> }

function gyroSupported(): boolean {
  return typeof window !== "undefined" && typeof DeviceOrientationEvent !== "undefined"
}

/** iPhone (iOS 13 and up) only hands over motion after a tap and a yes. */
function needsPermission(): boolean {
  return gyroSupported() && typeof (DeviceOrientationEvent as OrientationCtor).requestPermission === "function"
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/**
 * A trading card at 2.5:3.5 with rounded corners, a soft glow from its own
 * colours, glare that follows the light, and a holo shine for holo and
 * reverse-holo finishes. Ported from the customer binder sleeves
 * (apps/web/src/features/binders) and grown up for one big card.
 *
 * Under prefers-reduced-motion nothing moves: no tilt, no gyro listener, no
 * sweep. A holo card keeps a still shine, so the finish still reads.
 */
export function CardArt({
  src,
  alt,
  finish = "normal",
  tilt = true,
  gyro = false,
  glow = true,
  fallback,
  priority,
  maxTilt = 14,
  className,
}: CardArtProps) {
  const reduced = useMediaQuery(REDUCED_MOTION_QUERY)
  const kind = finish === "holo" || finish === "reverse" || finish === "normal" ? finish : finishKind(finish)
  const moving = tilt && !reduced
  const rootRef = React.useRef<HTMLDivElement>(null)
  const frame = React.useRef(0)
  const touching = React.useRef(false)
  const asked = React.useRef(false)
  const [failed, setFailed] = React.useState(false)
  const [wantGyro, setWantGyro] = React.useState(false)
  const show = Boolean(src) && !failed
  const gyroOn = gyro && moving && gyroSupported() && (!needsPermission() || wantGyro)

  /** x and y from 0 to 1 across the card; 0.5, 0.5 is flat. */
  const paint = React.useCallback(
    (x: number, y: number, active: boolean) => {
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(() => {
        const el = rootRef.current
        if (!el) return
        const dx = x - 0.5
        const dy = y - 0.5
        el.style.setProperty("--ca-rx", `${(-dy * maxTilt * 2).toFixed(2)}deg`)
        el.style.setProperty("--ca-ry", `${(dx * maxTilt * 2).toFixed(2)}deg`)
        el.style.setProperty("--ca-gx", `${(x * 100).toFixed(1)}%`)
        el.style.setProperty("--ca-gy", `${(y * 100).toFixed(1)}%`)
        el.style.setProperty("--ca-hx", `${(50 + dx * 60).toFixed(1)}%`)
        el.style.setProperty("--ca-hy", `${(50 + dy * 60).toFixed(1)}%`)
        el.style.setProperty("--ca-i", Math.min(1, Math.hypot(dx, dy) * 2).toFixed(3))
        el.dataset.active = active ? "true" : "false"
      })
    },
    [maxTilt]
  )

  const rest = React.useCallback(() => paint(0.5, 0.5, false), [paint])

  React.useEffect(() => () => cancelAnimationFrame(frame.current), [])

  // Gyro: Android and desktop fire straight away; iPhone needs a tap first.
  React.useEffect(() => {
    if (!gyroOn) return
    let base: number | null = null
    const onTilt = (event: DeviceOrientationEvent) => {
      if (touching.current || event.beta === null || event.gamma === null) return
      // The resting angle drifts towards however the phone is held, so the
      // card sits flat in the hand and moves as the hand moves.
      base = base === null ? event.beta : base * 0.97 + event.beta * 0.03
      const x = 0.5 + clamp(event.gamma / 40, -0.5, 0.5)
      const y = 0.5 + clamp((event.beta - base) / 40, -0.5, 0.5)
      paint(x, y, true)
    }
    window.addEventListener("deviceorientation", onTilt)
    return () => window.removeEventListener("deviceorientation", onTilt)
  }, [gyroOn, paint])

  const askForGyro = () => {
    if (!gyro || !moving || asked.current || !gyroSupported() || !needsPermission()) return
    asked.current = true
    ;(DeviceOrientationEvent as OrientationCtor)
      .requestPermission?.()
      .then((answer) => setWantGyro(answer === "granted"))
      .catch(() => undefined)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!moving) return
    const r = event.currentTarget.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    paint(clamp((event.clientX - r.left) / r.width, 0, 1), clamp((event.clientY - r.top) / r.height, 0, 1), true)
  }
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse") touching.current = true
    onPointerMove(event)
  }
  const onPointerEnd = () => {
    touching.current = false
    if (moving) rest()
  }

  return (
    <div
      ref={rootRef}
      role="img"
      aria-label={alt}
      data-finish={kind}
      data-motion={reduced ? "reduced" : "full"}
      data-gyro={gyroOn ? "on" : "off"}
      className={cn("ca", moving && "ca-tilt", className)}
      onPointerMove={moving ? onPointerMove : undefined}
      onPointerDown={moving ? onPointerDown : undefined}
      onPointerUp={
        moving
          ? () => {
              askForGyro()
              onPointerEnd()
            }
          : undefined
      }
      onPointerLeave={moving ? onPointerEnd : undefined}
      onPointerCancel={moving ? onPointerEnd : undefined}
    >
      {glow && (
        <div className="ca-glow" aria-hidden>
          {show && <img src={src} alt="" decoding="async" loading={priority ? "eager" : "lazy"} />}
        </div>
      )}
      <div className="ca-card">
        {show ? (
          <img
            className="ca-img"
            src={src}
            alt=""
            draggable={false}
            decoding="async"
            loading={priority ? "eager" : "lazy"}
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="ca-empty">{fallback ?? <span>No image yet</span>}</div>
        )}
        {kind !== "normal" && <i className="ca-holo" aria-hidden />}
        {kind === "holo" && !reduced && <i className="ca-sweep" aria-hidden />}
        <i className="ca-glare" aria-hidden />
        <i className="ca-edge" aria-hidden />
      </div>
    </div>
  )
}
