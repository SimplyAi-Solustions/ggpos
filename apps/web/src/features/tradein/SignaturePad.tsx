import * as React from "react"

import { Button } from "@/components/ui/button"
import { MicroLabel } from "@/components/ui/micro-label"
import {
  SIGNATURE_INK,
  exportSignature,
  isSamePoint,
  pointIn,
  type Point,
} from "@/features/tradein/signature"

export interface SignaturePadProps {
  /** Called with a PNG data URL, or null when the pad is cleared. */
  onChange: (signature: string | null) => void
  label?: string
}

const WIDTH = 640
const HEIGHT = 200

/**
 * The customer signs here.
 *
 * A plain canvas with pointer events, so a finger, a stylus and a mouse all
 * work the same way. The stroke is ink on paper at 2px, which is what the
 * receipt prints; nothing about it is decorative.
 */
export function SignaturePad({ onChange, label = "Signature" }: SignaturePadProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const drawing = React.useRef(false)
  const last = React.useRef<Point | null>(null)
  // A ref as well as state: the pointer-up handler has to know whether any
  // ink landed in the stroke it is finishing, and state would still be a
  // render behind.
  const inked = React.useRef(false)
  const [, setHasInk] = React.useState(false)

  const context = () => canvasRef.current?.getContext("2d") ?? null

  function begin(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    const ctx = context()
    if (!canvas || !ctx) return
    canvas.setPointerCapture(event.pointerId)
    drawing.current = true
    last.current = pointIn(canvas.getBoundingClientRect(), canvas, event)
  }

  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    const ctx = context()
    if (!drawing.current || !canvas || !ctx) return
    const point = pointIn(canvas.getBoundingClientRect(), canvas, event)
    const from = last.current
    if (!from || isSamePoint(from, point)) return

    // Always ink on paper, never the theme's foreground: a signature drawn
    // in night mode would export white on transparent and print blank, and
    // this one goes on a six-year purchase record.
    ctx.strokeStyle = SIGNATURE_INK
    ctx.lineWidth = 2
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(point.x, point.y)
    ctx.stroke()

    last.current = point
    if (!inked.current) {
      inked.current = true
      setHasInk(true)
    }
  }

  function end() {
    if (!drawing.current) return
    drawing.current = false
    last.current = null
    onChange(exportSignature(canvasRef.current, inked.current))
  }

  function clear() {
    const canvas = canvasRef.current
    const ctx = context()
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
    inked.current = false
    setHasInk(false)
    last.current = null
    onChange(null)
  }

  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <MicroLabel>{label}</MicroLabel>
        <Button variant="text" type="button" onClick={clear}>
          Clear
        </Button>
      </div>
      <canvas
        ref={canvasRef}
        data-testid="signature-pad"
        width={WIDTH}
        height={HEIGHT}
        aria-label="Signature pad. Sign with a finger or a stylus."
        role="img"
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        // White, in both modes, because that is what it exports and prints.
        className="mt-3 h-[140px] w-full touch-none border border-hairline bg-white sm:h-[180px]"
      />
      <p className="mt-2 text-[13px] leading-[1.45] text-muted-foreground-2">
        Sign above to confirm the items are yours to sell.
      </p>
    </div>
  )
}
