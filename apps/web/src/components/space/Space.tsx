import * as React from "react"

/**
 * The GG HQ space backdrop behind every customer page: a slow drifting
 * starfield with the odd volt shooting star, three nebulae and a glowing
 * planet horizon. Ported from GG HQ with the phone in mind:
 *
 *   - the animation loop stops while the tab is hidden,
 *   - small screens get fewer stars,
 *   - prefers-reduced-motion keeps the stars still and skips shooting stars,
 *   - in light mode the canvas and planet are gone (cosmos.css hides them and
 *     this component does not even start the loop), leaving faint nebulae.
 */

/** Dark is a class on <html>, so watch the class, not the media query. */
function useHtmlDark(): boolean {
  return React.useSyncExternalStore(
    (onChange) => {
      const observer = new MutationObserver(onChange)
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
      return () => observer.disconnect()
    },
    () => document.documentElement.classList.contains("dark"),
    () => false
  )
}

type Star = { x: number; y: number; z: number; tw: number; c: string }

export function Space({ planet = true }: { planet?: boolean }) {
  const ref = React.useRef<HTMLCanvasElement>(null)
  const dark = useHtmlDark()

  React.useEffect(() => {
    if (!dark) return undefined
    const cv = ref.current
    const ctx = cv?.getContext?.("2d")
    if (!cv || !ctx) return undefined

    let w = 0
    let h = 0
    let raf = 0
    let running = false
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    let stars: Star[] = []
    const shoot = { x: 0, y: 0, vx: 0, vy: 0, life: 0 }

    const resize = () => {
      w = cv.clientWidth
      h = cv.clientHeight
      cv.width = w * dpr
      cv.height = h * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      // Fewer stars on a phone: the cap keeps the frame cheap at 390px.
      const cap = w < 640 ? 130 : 360
      const count = Math.min(cap, Math.round((w * h) / 5200))
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        z: Math.random() * 0.9 + 0.1,
        tw: Math.random() * Math.PI * 2,
        c: Math.random() < 0.08 ? "254,223,1" : Math.random() < 0.05 ? "255,46,107" : "255,255,255",
      }))
    }
    resize()
    window.addEventListener("resize", resize)

    const reduce = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    let t = 0
    const frame = () => {
      t += 1
      ctx.clearRect(0, 0, w, h)
      for (const s of stars) {
        if (!reduce) {
          s.x -= s.z * 0.06
          if (s.x < 0) s.x = w
        }
        const a = 0.25 + 0.55 * s.z * (0.6 + 0.4 * Math.sin(t * 0.02 + s.tw))
        ctx.fillStyle = `rgba(${s.c},${a})`
        const r = s.z * 1.25
        ctx.beginPath()
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2)
        ctx.fill()
      }
      if (!reduce) {
        if (shoot.life <= 0 && Math.random() < 0.003) {
          shoot.x = Math.random() * w * 0.8 + w * 0.2
          shoot.y = Math.random() * h * 0.4
          shoot.vx = -(6 + Math.random() * 5)
          shoot.vy = 2 + Math.random() * 2
          shoot.life = 60
        }
        if (shoot.life > 0) {
          const g = ctx.createLinearGradient(shoot.x, shoot.y, shoot.x - shoot.vx * 14, shoot.y - shoot.vy * 14)
          g.addColorStop(0, `rgba(254,223,1,${shoot.life / 60})`)
          g.addColorStop(1, "rgba(254,223,1,0)")
          ctx.strokeStyle = g
          ctx.lineWidth = 1.6
          ctx.beginPath()
          ctx.moveTo(shoot.x, shoot.y)
          ctx.lineTo(shoot.x - shoot.vx * 14, shoot.y - shoot.vy * 14)
          ctx.stroke()
          shoot.x += shoot.vx
          shoot.y += shoot.vy
          shoot.life -= 1
        }
      }
      raf = requestAnimationFrame(frame)
    }

    const start = () => {
      if (running || typeof requestAnimationFrame !== "function") return
      running = true
      raf = requestAnimationFrame(frame)
    }
    const stop = () => {
      running = false
      cancelAnimationFrame(raf)
    }
    // A reduced-motion sky still gets painted once, then holds still.
    if (reduce) {
      t = 1
      frame()
      cancelAnimationFrame(raf)
    } else {
      start()
    }
    const onVisibility = () => {
      if (document.hidden) stop()
      else if (!reduce) start()
    }
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      stop()
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("resize", resize)
    }
  }, [dark])

  return (
    <div className="gg-space" aria-hidden="true">
      <div className="gg-nebula n1" />
      <div className="gg-nebula n2" />
      <div className="gg-nebula n3" />
      <canvas ref={ref} />
      {planet && dark ? <div className="gg-planet" /> : null}
    </div>
  )
}
