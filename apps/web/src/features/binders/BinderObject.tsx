import * as React from "react"
import { animate, motion, useMotionValue, type MotionStyle } from "motion/react"
import { LayersIcon } from "lucide-react"

import { colorOf, img, type BinderStats } from "@/features/binders/api"

/** The parts of a binder the cover needs; a draft in the create flow has no id yet. */
export interface BinderLook {
  name: string
  owner?: string
  kind: string
  color: string
  logo?: string
  cover?: string
}

// Zip track in a 100 x 122 box (the binder's ratio): from the spine top, round the edge, back to the spine bottom.
const ZIP_D = "M 12 3.4 H 91 Q 96.6 3.4 96.6 9 V 113 Q 96.6 118.6 91 118.6 H 12"

function Zip({ progress = 0, pullAt = 0, showPull = true }: { progress?: number; pullAt?: number; showPull?: boolean }) {
  const pathRef = React.useRef<SVGPathElement>(null)
  const [pt, setPt] = React.useState({ x: 12, y: 3.4, a: 0 })
  React.useEffect(() => {
    const p = pathRef.current
    if (!p || typeof p.getTotalLength !== "function") return
    const len = p.getTotalLength()
    const l = Math.max(0.001, Math.min(1, pullAt)) * len
    const a = p.getPointAtLength(l)
    const b = p.getPointAtLength(Math.min(len, l + 0.5))
    setPt({ x: a.x, y: a.y, a: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI })
  }, [pullAt])
  return (
    <svg className="bx-zip" viewBox="0 0 100 122" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="bxMetal" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f2f2f5" />
          <stop offset=".45" stopColor="#8d8d96" />
          <stop offset=".7" stopColor="#d7d7dd" />
          <stop offset="1" stopColor="#5f5f68" />
        </linearGradient>
      </defs>
      <path ref={pathRef} d={ZIP_D} className="tape" vectorEffect="non-scaling-stroke" />
      <path d={ZIP_D} className="teeth" vectorEffect="non-scaling-stroke" />
      <path d={ZIP_D} className="rail" vectorEffect="non-scaling-stroke" />
      {progress > 0 ? (
        <path d={ZIP_D} className="open" vectorEffect="non-scaling-stroke" pathLength={1} strokeDasharray={`${progress} 1`} />
      ) : null}
      {showPull ? (
        <g transform={`translate(${pt.x} ${pt.y}) rotate(${pt.a})`}>
          <rect x="-2.6" y="-2.2" width="5.2" height="4.4" rx="1.2" fill="url(#bxMetal)" stroke="#2b2b31" strokeWidth=".35" />
          <g transform="rotate(90)">
            <rect x="-1.3" y="1.2" width="2.6" height="8.6" rx="1.3" fill="url(#bxMetal)" stroke="#2b2b31" strokeWidth=".35" />
            <rect x="-.55" y="5.4" width="1.1" height="3" rx=".55" fill="#2b2b31" />
          </g>
        </g>
      ) : null}
    </svg>
  )
}

function BinderFace({ binder, stats, big = false }: { binder: BinderLook; stats: BinderStats | null; big?: boolean }) {
  const isSet = binder.kind === "set" && !!binder.logo
  const cands = [stats?.cover, binder.cover].filter((x): x is string => !!x)
  const [ci, setCi] = React.useState(0)
  const cover = cands[ci]
  return (
    <div className="bx-face">
      <div className="bx-owner">{binder.owner ? `${binder.owner}'s binder` : "GG binder"}</div>
      <div className="bx-title">{binder.name}</div>
      <div className="bx-window">
        {isSet ? (
          <img
            className="bx-logo"
            src={`${binder.logo}.webp`}
            alt=""
            loading="lazy"
            onError={(e) => (e.currentTarget.style.display = "none")}
          />
        ) : cover ? (
          <img
            key={cover}
            src={img(cover, big ? "high" : "low")}
            alt=""
            loading="lazy"
            onError={(e) => {
              const el = e.currentTarget
              if (el.src.includes("/high.")) el.src = img(cover, "low")
              else setCi((i) => i + 1)
            }}
          />
        ) : (
          <div className="bx-window-empty">
            <LayersIcon size={34} />
          </div>
        )}
      </div>
      {stats ? (
        <div className="bx-meta">
          <div className="bx-meta-row">
            <span>
              <b>{stats.got}</b>/{stats.total}
            </span>
            <span>{stats.total ? `${Math.round((stats.got / stats.total) * 100)}%` : ""}</span>
          </div>
          <div className="bx-prog">
            <i style={{ width: `${stats.total ? Math.max(2, (stats.got / stats.total) * 100) : 0}%` }} />
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function BinderCover({
  binder,
  stats,
  onOpen,
  zip = 0,
  showPull = true,
  big = false,
  coverStyle,
  flipped = false,
  children,
}: {
  binder: BinderLook
  stats: BinderStats | null
  onOpen?: () => void
  zip?: number
  showPull?: boolean
  big?: boolean
  coverStyle?: MotionStyle
  flipped?: boolean
  children?: React.ReactNode
}) {
  const complete = !!stats && stats.total > 0 && stats.got === stats.total
  const Tag = onOpen ? "button" : "div"
  return (
    <Tag
      type={onOpen ? "button" : undefined}
      className="bx-binder"
      style={{ "--bc": colorOf(binder.color) } as React.CSSProperties}
      onClick={onOpen}
      aria-label={onOpen ? `Open ${binder.name}` : undefined}
    >
      <div className="bx-drop" />
      <div className="bx-body">
        <div className="bx-pages" />
        {children}
        <motion.div className={`bx-cover ${flipped ? "flipped" : ""}`} style={coverStyle}>
          <div className="bx-spine" />
          <div className="bx-stitch" />
          <BinderFace binder={binder} stats={stats} big={big} />
          <Zip progress={zip} pullAt={zip} showPull={showPull} />
          {complete ? <span className="bx-badge-done">COMPLETE</span> : null}
          <div className="bx-cover-back" />
        </motion.div>
      </div>
    </Tag>
  )
}

/** The unzip-and-open moment after a binder is made. Tap anywhere to skip. */
export function OpeningStage({
  binder,
  stats,
  preview,
  onDone,
}: {
  binder: BinderLook
  stats: BinderStats | null
  preview: { image: string; owned: boolean }[]
  onDone: () => void
}) {
  const [zip, setZip] = React.useState(0)
  const [flipped, setFlipped] = React.useState(false)
  const rot = useMotionValue(0)
  const zipMv = useMotionValue(0)
  const done = React.useRef(false)
  const doneRef = React.useRef(onDone)
  React.useEffect(() => {
    doneRef.current = onDone
  }, [onDone])
  const finish = React.useCallback(() => {
    if (!done.current) {
      done.current = true
      doneRef.current()
    }
  }, [])

  React.useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      finish()
      return undefined
    }
    const unsub = zipMv.on("change", (v) => setZip(v))
    const unsubR = rot.on("change", (v) => setFlipped(v < -90))
    let cancelled = false
    void (async () => {
      await new Promise((r) => setTimeout(r, 380))
      if (cancelled) return
      await animate(zipMv, 1, { duration: 1.05, ease: [0.45, 0, 0.2, 1] })
      if (cancelled) return
      await animate(rot, -168, { duration: 0.95, ease: [0.6, 0.02, 0.2, 1] })
      await new Promise((r) => setTimeout(r, 260))
      if (!cancelled) finish()
    })()
    return () => {
      cancelled = true
      unsub()
      unsubR()
    }
  }, [finish, rot, zipMv])

  return (
    <motion.div
      className="bx-stage"
      onClick={finish}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.35 } }}
    >
      <motion.div
        className="bx-stage-inner"
        initial={{ scale: 0.55, y: 60, rotateX: 18, opacity: 0 }}
        animate={{ scale: 1, y: 0, rotateX: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 120, damping: 18 }}
      >
        <BinderCover binder={binder} stats={stats} zip={zip} big coverStyle={{ rotateY: rot }} flipped={flipped} showPull={!flipped}>
          <div className="bx-inside">
            {Array.from({ length: 9 }, (_, i) => {
              const c = preview[i]
              return (
                <div key={i} className={`bx-mini ${c?.owned ? "got" : ""}`}>
                  {c?.image ? (
                    <img src={img(c.image)} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />
                  ) : null}
                </div>
              )
            })}
          </div>
        </BinderCover>
      </motion.div>
      <div className="bx-stage-hint">
        {zip < 1 ? "Unzipping" : "Opening"} {binder.name}
      </div>
    </motion.div>
  )
}
