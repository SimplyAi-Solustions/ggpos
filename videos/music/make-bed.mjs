/**
 * Writes public/music/bed.wav: a calm, loopable background track for the
 * tutorials, made from code so there is no licence to worry about.
 *
 * 88 beats a minute, a four-chord loop (Cmaj9, Am9, Fmaj9, G6) played as a
 * slow pad, a soft plucked arpeggio and a round bass. Each pass of the loop
 * is 8 bars (about 22 seconds); the file holds 6 passes (about 2 minutes 11
 * seconds) and its tails wrap round to the start, so Remotion can loop it
 * under a longer video without a click. The first pass is pad and bass only,
 * so the track opens softly and breathes again each time it loops.
 */
import { writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const RATE = 44100
const BPM = 88
const BEAT = 60 / BPM
const BAR = BEAT * 4
const PASSES = 6

// Midi notes per chord: pad voicing, arpeggio pattern, bass root.
const CHORDS = [
  { pad: [48, 55, 59, 62, 64], arp: [60, 64, 67, 71, 74, 71, 67, 64], bass: 36 }, // Cmaj9
  { pad: [45, 52, 55, 59, 60], arp: [57, 60, 64, 67, 71, 67, 64, 60], bass: 33 }, // Am9
  { pad: [41, 48, 52, 55, 57], arp: [53, 57, 60, 64, 67, 64, 60, 57], bass: 29 }, // Fmaj9
  { pad: [43, 50, 52, 55, 59], arp: [55, 59, 62, 64, 67, 64, 62, 59], bass: 31 }, // G6
]
const BARS_PER_CHORD = 2
const LOOP_BARS = CHORDS.length * BARS_PER_CHORD
const LENGTH = LOOP_BARS * BAR * PASSES
const FRAMES = Math.round(LENGTH * RATE)

const left = new Float32Array(FRAMES)
const right = new Float32Array(FRAMES)

const freq = (midi) => 440 * Math.pow(2, (midi - 69) / 12)

/** Adds a note: a few soft partials with an attack and release envelope. */
function note({ midi, start, dur, gain, attack, release, partials, pan = 0, detune = 0 }) {
  const f = freq(midi) * Math.pow(2, detune / 1200)
  const s0 = Math.floor(start * RATE)
  const total = Math.floor((dur + release) * RATE)
  const lGain = gain * Math.cos(((pan + 1) * Math.PI) / 4)
  const rGain = gain * Math.sin(((pan + 1) * Math.PI) / 4)
  for (let i = 0; i < total; i++) {
    const idx = (s0 + i) % FRAMES // wrap so the end flows into the start
    const t = i / RATE
    let env
    if (t < attack) env = t / attack
    else if (t < dur) env = 1
    else env = Math.max(0, 1 - (t - dur) / release)
    env = env * env * (3 - 2 * env) // smoothstep
    let v = 0
    for (const [mult, amp] of partials) v += amp * Math.sin(2 * Math.PI * f * mult * t)
    left[idx] += v * env * lGain
    right[idx] += v * env * rGain
  }
}

/** A plucked note: quick attack, exponential decay. */
function pluck({ midi, start, gain, pan }) {
  const f = freq(midi)
  const s0 = Math.floor(start * RATE)
  const total = Math.floor(1.8 * RATE)
  const lGain = gain * Math.cos(((pan + 1) * Math.PI) / 4)
  const rGain = gain * Math.sin(((pan + 1) * Math.PI) / 4)
  for (let i = 0; i < total; i++) {
    const idx = (s0 + i) % FRAMES
    const t = i / RATE
    const env = Math.min(1, t / 0.006) * Math.exp(-t * 3.2)
    const v =
      Math.sin(2 * Math.PI * f * t) +
      0.35 * Math.sin(2 * Math.PI * f * 2 * t) * Math.exp(-t * 6) +
      0.12 * Math.sin(2 * Math.PI * f * 3 * t) * Math.exp(-t * 9)
    left[idx] += v * env * lGain
    right[idx] += v * env * rGain
  }
}

const PAD_PARTIALS = [
  [1, 1],
  [2, 0.18],
  [3, 0.06],
]

for (let pass = 0; pass < PASSES; pass++) {
  for (let c = 0; c < CHORDS.length; c++) {
    const chord = CHORDS[c]
    const start = (pass * LOOP_BARS + c * BARS_PER_CHORD) * BAR
    const dur = BARS_PER_CHORD * BAR
    // Pad: each note twice, slightly detuned and spread, for width.
    chord.pad.forEach((midi, i) => {
      const pan = -0.6 + (1.2 * i) / (chord.pad.length - 1)
      note({ midi, start, dur, gain: 0.05, attack: 1.4, release: 1.6, partials: PAD_PARTIALS, pan, detune: -6 })
      note({ midi, start, dur, gain: 0.05, attack: 1.6, release: 1.6, partials: PAD_PARTIALS, pan: -pan, detune: 6 })
    })
    // Bass: a round note on beat one of each bar.
    for (let b = 0; b < BARS_PER_CHORD; b++) {
      note({
        midi: chord.bass,
        start: start + b * BAR,
        dur: BAR * 0.9,
        gain: 0.16,
        attack: 0.04,
        release: 0.5,
        partials: [
          [1, 1],
          [2, 0.25],
        ],
      })
    }
    // Arpeggio: eighth notes, from the second pass so the track opens softly.
    if (pass === 0) continue
    for (let b = 0; b < BARS_PER_CHORD; b++) {
      chord.arp.forEach((midi, i) => {
        const t = start + b * BAR + i * (BEAT / 2)
        pluck({ midi, start: t, gain: i % 2 === 0 ? 0.06 : 0.04, pan: i % 2 === 0 ? -0.35 : 0.35 })
      })
    }
  }
}

// A gentle low-pass (one pole) to round off the top, then normalise to -3 dBFS.
for (const ch of [left, right]) {
  let prev = 0
  const a = 0.28
  for (let i = 0; i < ch.length; i++) {
    prev = prev + a * (ch[i] - prev)
    ch[i] = prev
  }
}
let peak = 0
for (let i = 0; i < FRAMES; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]))
const scale = peak > 0 ? 0.707 / peak : 1

const data = Buffer.alloc(44 + FRAMES * 4)
data.write("RIFF", 0)
data.writeUInt32LE(36 + FRAMES * 4, 4)
data.write("WAVE", 8)
data.write("fmt ", 12)
data.writeUInt32LE(16, 16)
data.writeUInt16LE(1, 20)
data.writeUInt16LE(2, 22)
data.writeUInt32LE(RATE, 24)
data.writeUInt32LE(RATE * 4, 28)
data.writeUInt16LE(4, 32)
data.writeUInt16LE(16, 34)
data.write("data", 36)
data.writeUInt32LE(FRAMES * 4, 40)
for (let i = 0; i < FRAMES; i++) {
  data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(left[i] * scale * 32767))), 44 + i * 4)
  data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(right[i] * scale * 32767))), 46 + i * 4)
}

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "music", "bed.wav")
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, data)
console.log(`wrote ${out}: ${LENGTH.toFixed(1)} s`)
