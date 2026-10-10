import React from "react"
import { loadFont } from "@remotion/fonts"
import { AbsoluteFill, staticFile, useCurrentFrame } from "remotion"

/** GG's palette, as DESIGN.md and the website set it. */
export const C = {
  paper: "#fbfbfa",
  paper2: "#f3f3ef",
  ink: "#0b0b0b",
  ink2: "#3d3d3a",
  ink3: "#7a7a74",
  volt: "#fedf01",
  pop: "#ff2e6b",
  white: "#ffffff",
} as const

export const FONT = {
  display: "Anton, Impact, sans-serif",
  mono: "'Space Mono', monospace",
  sans: "Jost, Futura, sans-serif",
} as const

let fontsLoading: Promise<unknown> | null = null
/** The three faces the app uses, from the same files. */
export function loadBrandFonts() {
  if (!fontsLoading) {
    fontsLoading = Promise.all([
      loadFont({ family: "Anton", url: staticFile("fonts/anton.woff2"), weight: "400" }),
      loadFont({ family: "Space Mono", url: staticFile("fonts/space-mono-400.woff2"), weight: "400" }),
      loadFont({ family: "Space Mono", url: staticFile("fonts/space-mono-700.woff2"), weight: "700" }),
      loadFont({ family: "Jost", url: staticFile("fonts/jost.woff2"), weight: "100 900" }),
    ])
  }
  return fontsLoading
}

// The GG lockup from apps/web/src/design/brand/logo-paths.ts.
const LOGO = {
  viewBox: "0 0 316.32 100",
  stroke: 11.28,
  paper:
    "M64.69 5.93L168.25 5.93L145.99 30.86L75.37 30.86L71.51 32.05L68.25 35.91L51.04 66.77L50.45 69.73L51.34 72.11L54.9 74.18L101.78 74.18L109.79 61.13L81.31 61.13L92.58 45.4L154.9 45.4L126.11 94.07L22.55 94.36L18.1 94.07L13.06 92.58L7.72 88.13L5.64 83.38L5.64 78.93L6.53 75.96L37.39 22.85L44.21 15.43L50.45 10.98L57.27 7.72Z",
  volt: "M240.95 5.64L310.68 5.93L287.24 30.86L212.17 30.86L209.5 31.75L205.93 35.61L197.33 51.04L187.24 67.06L186.35 69.14L186.65 71.51L187.83 73L190.8 74.18L240.65 73.89L248.37 60.83L218.99 60.83L230.27 45.4L298.81 45.4L267.06 94.07L156.97 94.07L149.55 91.39L145.99 88.43L143.03 82.79L143.03 78.34L143.92 75.67L172.7 25.82L180.71 16.32L188.43 10.68L193.18 8.31L200 6.23Z",
}

/** The GG lockup: the paper G and the volt G, outlined in ink. */
export const Logo: React.FC<{ height: number; style?: React.CSSProperties }> = ({ height, style }) => (
  <svg viewBox={LOGO.viewBox} height={height} style={{ display: "block", overflow: "visible", ...style }}>
    <path d={LOGO.paper} fill={C.white} stroke={C.ink} strokeWidth={LOGO.stroke} strokeLinejoin="round" paintOrder="stroke" />
    <path d={LOGO.volt} fill={C.volt} stroke={C.ink} strokeWidth={LOGO.stroke} strokeLinejoin="round" paintOrder="stroke" />
  </svg>
)

/** The paper grain the app draws over its canvas, a little stronger for video. */
export const Grain: React.FC<{ opacity?: number; dark?: boolean }> = ({ opacity = 0.05, dark = false }) => (
  <AbsoluteFill style={{ pointerEvents: "none", opacity, mixBlendMode: dark ? "screen" : "multiply" }}>
    <svg width="100%" height="100%">
      <filter id={dark ? "grain-dark" : "grain"}>
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter={`url(#${dark ? "grain-dark" : "grain"})`} />
    </svg>
  </AbsoluteFill>
)

/** A tracked uppercase micro-label in Space Mono, the app's label voice. */
export const Micro: React.FC<{ children: React.ReactNode; color?: string; size?: number; style?: React.CSSProperties }> = ({
  children,
  color = C.ink,
  size = 18,
  style,
}) => (
  <div
    style={{
      fontFamily: FONT.mono,
      fontWeight: 700,
      fontSize: size,
      letterSpacing: "0.16em",
      textTransform: "uppercase",
      color,
      ...style,
    }}
  >
    {children}
  </div>
)

/** The website's yellow ticker: words separated by diamonds, sliding left. */
export const Ticker: React.FC<{ words: string[]; height?: number; speed?: number }> = ({ words, height = 64, speed = 2.2 }) => {
  const frame = useCurrentFrame()
  const run = [...words, ...words, ...words, ...words, ...words, ...words]
  return (
    <div
      style={{
        height,
        background: C.volt,
        borderTop: `3px solid ${C.ink}`,
        borderBottom: `3px solid ${C.ink}`,
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
      }}
    >
      <div style={{ display: "flex", whiteSpace: "nowrap", transform: `translateX(${-(frame * speed) % 1200}px)` }}>
        {run.map((w, i) => (
          <span key={i} style={{ fontFamily: FONT.display, fontSize: height * 0.5, color: C.ink, textTransform: "uppercase", padding: "0 28px" }}>
            {w}
            <span style={{ paddingLeft: 56, fontSize: height * 0.32 }}>◆</span>
          </span>
        ))}
      </div>
    </div>
  )
}
