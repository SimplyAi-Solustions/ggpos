import React from "react"
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"

import { C, FONT, Grain, Logo, Micro, Ticker } from "./brand"
import type { Manifest } from "./timing"

const ease = Easing.bezier(0.16, 1, 0.3, 1) // the site's out-expo

/** Fades and lifts into place from `start`, to `max` opacity. */
function rise(frame: number, start: number, distance = 40, length = 18, max = 1) {
  const t = interpolate(frame, [start, start + length], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease })
  return { opacity: t * max, transform: `translateY(${(1 - t) * distance}px)` }
}

const pad = (n: number) => String(n).padStart(2, "0")

/** The opening card: ink, the GG lockup, the tutorial's number and title. */
export const Intro: React.FC<{ m: Manifest }> = ({ m }) => {
  const frame = useCurrentFrame()
  const { fps, durationInFrames } = useVideoConfig()
  const out = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const bar = spring({ frame: frame - 14, fps, config: { damping: 200 } })
  return (
    <AbsoluteFill style={{ background: C.ink, opacity: out }}>
      <Grain dark opacity={0.08} />
      <div style={{ position: "absolute", left: 120, top: 96, ...rise(frame, 0, 20) }}>
        <Logo height={64} />
      </div>
      <Micro color={C.paper} size={18} style={{ position: "absolute", right: 120, top: 118, ...rise(frame, 4, 20, 18, 0.7) }}>
        GG Vault · How to
      </Micro>
      <div style={{ position: "absolute", left: 120, top: 330, right: 120 }}>
        <Micro color={C.volt} size={22} style={rise(frame, 8)}>
          Tutorial {pad(m.number)}
        </Micro>
        <div
          style={{
            fontFamily: FONT.display,
            fontSize: 148,
            lineHeight: 1,
            color: C.paper,
            textTransform: "uppercase",
            marginTop: 26,
            letterSpacing: "0.01em",
            ...rise(frame, 12, 60, 22),
          }}
        >
          {m.title}
        </div>
        <div style={{ height: 8, width: 220 * bar, background: C.volt, marginTop: 34 }} />
        <div style={{ fontFamily: FONT.sans, fontSize: 40, color: C.paper, marginTop: 34, maxWidth: 1300, ...rise(frame, 24, 40, 18, 0.78) }}>
          {m.subtitle}
        </div>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 80, ...rise(frame, 18, 30) }}>
        <Ticker words={["GG Vault", "Game", "Trade", "Play", m.title]} />
      </div>
    </AbsoluteFill>
  )
}

/** "In this video": what the tutorial covers, item by item. */
export const Outline: React.FC<{ m: Manifest }> = ({ m }) => {
  const frame = useCurrentFrame()
  const { durationInFrames } = useVideoConfig()
  const out = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  return (
    <AbsoluteFill style={{ background: C.paper, opacity: out }}>
      <Grain opacity={0.06} />
      <div style={{ position: "absolute", left: 160, top: 150, right: 160 }}>
        <Micro size={20} style={rise(frame, 0, 20)}>
          In this video
        </Micro>
        <div style={{ fontFamily: FONT.display, fontSize: 86, color: C.ink, textTransform: "uppercase", marginTop: 18, ...rise(frame, 4, 30) }}>
          {m.title}
        </div>
        <div style={{ marginTop: 60, display: "flex", flexDirection: "column", gap: 30 }}>
          {m.outline.map((line, i) => (
            <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 36, ...rise(frame, 14 + i * 9, 24) }}>
              <span style={{ fontFamily: FONT.mono, fontWeight: 700, fontSize: 26, color: C.ink, background: C.volt, padding: "4px 12px" }}>
                {pad(i + 1)}
              </span>
              <span style={{ fontFamily: FONT.sans, fontSize: 44, color: C.ink, fontWeight: 400 }}>{line}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ position: "absolute", right: 120, bottom: 96, opacity: 0.9 }}>
        <Logo height={44} />
      </div>
    </AbsoluteFill>
  )
}

/** A chapter card between parts of a tutorial. */
export const SectionCard: React.FC<{ title: string; number: number }> = ({ title, number }) => {
  const frame = useCurrentFrame()
  const { durationInFrames } = useVideoConfig()
  const wipe = interpolate(frame, [0, 14], [0, 1], { extrapolateRight: "clamp", easing: ease })
  const out = interpolate(frame, [durationInFrames - 8, durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  return (
    <AbsoluteFill style={{ background: C.paper, opacity: out }}>
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${wipe * 100}%`, background: C.ink }} />
      <Grain dark opacity={0.07} />
      <div style={{ position: "absolute", left: 160, top: 400, right: 160 }}>
        <Micro color={C.volt} size={22} style={rise(frame, 8, 24)}>
          Part {pad(number)}
        </Micro>
        <div style={{ fontFamily: FONT.display, fontSize: 120, color: C.paper, textTransform: "uppercase", marginTop: 20, lineHeight: 1.02, ...rise(frame, 11, 50, 20) }}>
          {title}
        </div>
      </div>
    </AbsoluteFill>
  )
}

/** The closing card: what comes next, and where GG Vault lives. */
export const Outro: React.FC<{ m: Manifest }> = ({ m }) => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill style={{ background: C.ink }}>
      <Grain dark opacity={0.08} />
      <div style={{ position: "absolute", left: 120, top: 96, ...rise(frame, 0, 20) }}>
        <Logo height={64} />
      </div>
      <div style={{ position: "absolute", left: 120, top: 330, right: 120 }}>
        <Micro color={C.volt} size={22} style={rise(frame, 6)}>
          That's {m.title.toLowerCase()}
        </Micro>
        {m.next ? (
          <>
            <Micro color={C.paper} size={20} style={{ marginTop: 70, ...rise(frame, 12, 40, 18, 0.6) }}>
              Next
            </Micro>
            <div style={{ fontFamily: FONT.display, fontSize: 120, color: C.paper, textTransform: "uppercase", marginTop: 16, ...rise(frame, 16, 50, 22) }}>
              {m.next}
            </div>
          </>
        ) : (
          <div style={{ fontFamily: FONT.display, fontSize: 120, color: C.paper, textTransform: "uppercase", marginTop: 40, ...rise(frame, 12, 50, 22) }}>
            You're ready for the counter
          </div>
        )}
        <div style={{ fontFamily: FONT.mono, fontSize: 26, color: C.paper, marginTop: 50, ...rise(frame, 26, 40, 18, 0.7) }}>
          ggpos.ggentertainment.co.uk
        </div>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 80, ...rise(frame, 20, 30) }}>
        <Ticker words={["Game", "Trade", "Play", "GG Vault"]} />
      </div>
    </AbsoluteFill>
  )
}
