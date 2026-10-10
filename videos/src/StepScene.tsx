import React from "react"
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion"

import { C, FONT, Grain, Logo, Micro } from "./brand"
import type { Box, Manifest, Step } from "./timing"

// The screen sits above an ink caption band: 1440 by 900, the counter's own
// size on the Mac, so a capture is shown pixel for pixel until it zooms.
export const BAND = 140
export const SCREEN_W = 1440
export const SCREEN_H = 900
export const SCREEN_X = Math.round((1920 - SCREEN_W) / 2)
export const SCREEN_Y = 18

export interface Camera {
  z: number
  cx: number
  cy: number
}

export const FULL: Camera = { z: 1, cx: SCREEN_W / 2, cy: SCREEN_H / 2 }

const ease = Easing.bezier(0.45, 0, 0.2, 1)
const outExpo = Easing.bezier(0.16, 1, 0.3, 1)

/** A capture box in screen pixels. */
export function toScreen(box: Box, m: Manifest): Box {
  const k = SCREEN_W / m.viewport.width
  return { x: box.x * k, y: box.y * k, w: box.w * k, h: box.h * k }
}

/** Where the camera ends a step: pushed in on a zoomed step's target, else the whole screen. */
export function cameraFor(step: Step | null, m: Manifest): Camera {
  if (!step || !step.zoom || !step.target) return FULL
  const t = toScreen(step.target, m)
  const z = Math.min(2.1, Math.max(1.3, Math.min((SCREEN_W * 0.5) / Math.max(t.w, 1), (SCREEN_H * 0.45) / Math.max(t.h, 1))))
  const halfW = SCREEN_W / (2 * z)
  const halfH = SCREEN_H / (2 * z)
  const cx = Math.min(SCREEN_W - halfW, Math.max(halfW, t.x + t.w / 2))
  const cy = Math.min(SCREEN_H - halfH, Math.max(halfH, t.y + t.h / 2))
  return { z, cx, cy }
}

/** Where the pointer rests after a step: on the target of a click or a type, else where it was. */
export function pointerAfter(steps: Step[], index: number, m: Manifest): { x: number; y: number } {
  for (let i = index; i >= 0; i--) {
    const s = steps[i]
    if (s.target && (s.action === "click" || s.action === "type" || s.action === "press")) {
      const t = toScreen(s.target, m)
      return { x: t.x + t.w / 2, y: t.y + t.h / 2 }
    }
  }
  return { x: SCREEN_W * 0.62, y: SCREEN_H * 0.72 }
}

function mix(a: Camera, b: Camera, t: number): Camera {
  // Interpolate the visible window rather than the raw numbers, so a pan
  // between two zooms travels in a straight line on screen.
  const z = a.z + (b.z - a.z) * t
  return { z, cx: a.cx + (b.cx - a.cx) * t, cy: a.cy + (b.cy - a.cy) * t }
}

function project(p: { x: number; y: number }, cam: Camera) {
  return { x: SCREEN_W / 2 + (p.x - cam.cx) * cam.z, y: SCREEN_H / 2 + (p.y - cam.cy) * cam.z }
}

const Pointer: React.FC<{ x: number; y: number; press: number; opacity: number }> = ({ x, y, press, opacity }) => (
  <svg
    width={40}
    height={40}
    viewBox="0 0 24 24"
    style={{
      position: "absolute",
      left: x - 6,
      top: y - 3,
      opacity,
      transform: `scale(${1 - press * 0.16})`,
      transformOrigin: "6px 3px",
      filter: "drop-shadow(0 3px 6px rgba(11,11,11,0.35))",
    }}
  >
    <path d="M5 2.5 L5 19.5 L9.6 15.3 L12.6 22 L15.6 20.7 L12.7 14.1 L19 14.1 Z" fill={C.ink} stroke={C.white} strokeWidth={1.6} strokeLinejoin="round" />
  </svg>
)

export const StepScene: React.FC<{
  m: Manifest
  step: Step
  index: number
  prev: Step | null
  startCamera: Camera
  pointerFrom: { x: number; y: number }
  chapterNumber: number
}> = ({ m, step, index, prev, startCamera, pointerFrom, chapterNumber }) => {
  const frame = useCurrentFrame()
  const { durationInFrames: D } = useVideoConfig()
  const total = m.steps.length

  const endCamera = cameraFor(step, m)
  const camT = interpolate(frame, [4, 34], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease })
  const cam = mix(startCamera, endCamera, camT)

  const acts = step.target && (step.action === "click" || step.action === "type" || step.action === "press")
  const target = step.target ? toScreen(step.target, m) : null
  const aim = target ? { x: target.x + target.w / 2, y: target.y + target.h / 2 } : pointerFrom

  // The pointer travels while the camera moves, then waits on the target.
  const travel = interpolate(frame, [8, 34], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease })
  const pointerAt = acts ? { x: pointerFrom.x + (aim.x - pointerFrom.x) * travel, y: pointerFrom.y + (aim.y - pointerFrom.y) * travel } : pointerFrom
  const pointerOpacity = acts
    ? interpolate(frame, [0, 8], [prev && prev.action !== "highlight" && prev.action !== "none" ? 1 : 0, 1], { extrapolateRight: "clamp" })
    : interpolate(frame, [0, 8], [prev && prev.action !== "highlight" && prev.action !== "none" ? 1 : 0, 0], { extrapolateRight: "clamp" })

  // A click lands just before the cut to the next screen; a field is clicked
  // early so the typing can be watched.
  const clickAt = step.action === "type" ? 38 : D - 16
  const press = acts ? interpolate(frame, [clickAt - 3, clickAt, clickAt + 6], [0, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 0
  const ripple = acts ? interpolate(frame, [clickAt, clickAt + 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 0

  const p = project(pointerAt, cam)

  // Highlights dim the rest of the screen and draw a volt box.
  const big = target ? (target.w * target.h) / (SCREEN_W * SCREEN_H) > 0.6 : false
  const spot = step.action === "highlight" && target && !big ? interpolate(frame, [8, 22], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: outExpo }) : 0
  const tl = target ? project({ x: target.x, y: target.y }, cam) : null
  const br = target ? project({ x: target.x + target.w, y: target.y + target.h }, cam) : null

  // Typing callout.
  const typed = step.action === "type" && step.value ? step.value : ""
  const typeStart = clickAt + 6
  const chars = Math.floor(interpolate(frame, [typeStart, typeStart + Math.max(1, typed.length * 2.4)], [0, typed.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }))
  const calloutIn = interpolate(frame, [typeStart - 6, typeStart + 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: outExpo })

  const fadePrev = prev ? interpolate(frame, [0, 9], [1, 0], { extrapolateRight: "clamp" }) : 0
  const captionIn = interpolate(frame, [2, 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: outExpo })
  const progress = (index + Math.min(1, frame / D)) / total

  const imgStyle: React.CSSProperties = { position: "absolute", left: 0, top: 0, width: SCREEN_W, height: SCREEN_H }
  const camStyle: React.CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    width: SCREEN_W,
    height: SCREEN_H,
    transformOrigin: "0 0",
    transform: `translate(${SCREEN_W / 2 - cam.cx * cam.z}px, ${SCREEN_H / 2 - cam.cy * cam.z}px) scale(${cam.z})`,
  }

  return (
    <AbsoluteFill style={{ background: C.paper2 }}>
      <Grain opacity={0.06} />

      {/* The screen */}
      <div
        style={{
          position: "absolute",
          left: SCREEN_X,
          top: SCREEN_Y,
          width: SCREEN_W,
          height: SCREEN_H,
          borderRadius: 14,
          overflow: "hidden",
          background: C.paper,
          boxShadow: "0 1px 2px rgba(11,11,11,0.06), 0 30px 60px rgba(11,11,11,0.14)",
          outline: "1px solid rgba(11,11,11,0.12)",
        }}
      >
        <div style={camStyle}>
          <Img src={staticFile(`captures/${m.slug}/${step.image}`)} style={imgStyle} />
          {prev && fadePrev > 0 ? <Img src={staticFile(`captures/${m.slug}/${prev.image}`)} style={{ ...imgStyle, opacity: fadePrev }} /> : null}
        </div>

        {spot > 0 && tl && br ? (
          <>
            <svg width={SCREEN_W} height={SCREEN_H} style={{ position: "absolute", left: 0, top: 0, opacity: spot * 0.5 }}>
              <defs>
                <mask id={`spot-${index}`}>
                  <rect width={SCREEN_W} height={SCREEN_H} fill="white" />
                  <rect x={tl.x - 10} y={tl.y - 10} width={br.x - tl.x + 20} height={br.y - tl.y + 20} rx={12} fill="black" />
                </mask>
              </defs>
              <rect width={SCREEN_W} height={SCREEN_H} fill={C.ink} mask={`url(#spot-${index})`} />
            </svg>
            <div
              style={{
                position: "absolute",
                left: tl.x - 10,
                top: tl.y - 10,
                width: br.x - tl.x + 20,
                height: br.y - tl.y + 20,
                borderRadius: 12,
                border: `4px solid ${C.volt}`,
                boxShadow: `0 0 0 2px ${C.ink}`,
                opacity: spot,
                transform: `scale(${1.04 - 0.04 * spot})`,
              }}
            />
          </>
        ) : null}

        {ripple > 0 && ripple < 1 ? (
          <div
            style={{
              position: "absolute",
              left: p.x - 50 * ripple,
              top: p.y - 50 * ripple,
              width: 100 * ripple,
              height: 100 * ripple,
              borderRadius: "50%",
              border: `5px solid ${C.volt}`,
              boxShadow: `0 0 0 2px ${C.ink}`,
              opacity: 1 - ripple,
            }}
          />
        ) : null}

        {typed && calloutIn > 0 && tl && br ? (
          <div
            style={{
              position: "absolute",
              left: Math.min(SCREEN_W - 520, Math.max(16, tl.x)),
              top: br.y + 18 + 70 < SCREEN_H ? br.y + 18 : tl.y - 88,
              opacity: calloutIn,
              transform: `translateY(${(1 - calloutIn) * 10}px)`,
              background: C.ink,
              color: C.paper,
              borderRadius: 10,
              padding: "14px 22px",
              display: "flex",
              alignItems: "center",
              gap: 18,
              boxShadow: "0 12px 30px rgba(11,11,11,0.3)",
            }}
          >
            <Micro color={C.volt} size={15}>
              Type
            </Micro>
            <span style={{ fontFamily: FONT.sans, fontSize: 30, fontWeight: 500 }}>
              {typed.slice(0, chars)}
              <span style={{ opacity: frame % 20 < 10 ? 1 : 0, color: C.volt }}>|</span>
            </span>
          </div>
        ) : null}

        <Pointer x={p.x} y={p.y} press={press} opacity={pointerOpacity} />
      </div>

      {/* The caption band */}
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: BAND, background: C.ink }}>
        <div style={{ position: "absolute", left: 0, top: 0, height: 5, width: `${progress * 100}%`, background: C.volt }} />
        {/* Stops short of the logo and step count on the right; a long caption steps down a size so it stays on two lines. */}
        <div style={{ position: "absolute", left: SCREEN_X, right: SCREEN_X + 210, top: 22, opacity: captionIn, transform: `translateY(${(1 - captionIn) * 8}px)` }}>
          <Micro color={C.volt} size={15}>
            {chapterNumber > 0 ? `Part ${String(chapterNumber).padStart(2, "0")} · ` : ""}
            {step.chapter || m.title}
          </Micro>
          <div style={{ fontFamily: FONT.sans, fontSize: step.caption.length > 130 ? 29 : 32, color: C.paper, marginTop: 10, lineHeight: 1.2, fontWeight: 400 }}>
            {step.caption}
          </div>
        </div>
        <div style={{ position: "absolute", right: SCREEN_X, top: 26, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 14 }}>
          <Logo height={26} />
          <Micro color={C.paper} size={14} style={{ opacity: 0.6 }}>
            Step {index + 1} / {total}
          </Micro>
        </div>
      </div>
    </AbsoluteFill>
  )
}
