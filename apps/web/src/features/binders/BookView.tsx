import * as React from "react"
import { motion, useMotionValue, useTransform, animate } from "motion/react"

interface Turn {
  from: number
  to: number
  dir: 1 | -1
}

/**
 * The open binder, drawn as a book with a real page turn.
 *
 * Phones see one page; a wide screen sees a two-page spread. Changing
 * `page` lifts the page by its outer edge and swings it over the rings on a
 * 3D hinge, with the light falling off the paper as it goes edge-on, and the
 * next page waiting underneath. On a spread the back of the turning page is
 * the next left-hand page, the way a real binder works. A swipe turns the
 * page too. With reduced motion the page just changes.
 *
 * `page` is the page shown (the left page of a spread, always even there).
 */
export function BookView({
  count,
  page,
  spread,
  reduced,
  onSwipe,
  renderPage,
}: {
  count: number
  page: number
  spread: boolean
  reduced: boolean
  onSwipe: (dir: 1 | -1) => void
  renderPage: (index: number, live: boolean) => React.ReactNode
}) {
  const [shown, setShown] = React.useState(page)
  const [turn, setTurn] = React.useState<Turn | null>(null)
  const [prevPage, setPrevPage] = React.useState(page)
  const [prevReduced, setPrevReduced] = React.useState(reduced)

  // Derived from the page prop during render (React's "previous prop"
  // pattern), so a page change starts its turn in the same frame.
  if (page !== prevPage || reduced !== prevReduced) {
    setPrevPage(page)
    setPrevReduced(reduced)
    const from = turn ? turn.to : shown
    if (reduced || page === from) {
      setShown(page)
      setTurn(null)
    } else {
      setShown(from)
      setTurn({ from, to: page, dir: page > from ? 1 : -1 })
    }
  }

  const rot = useMotionValue(0)
  const shade = useTransform(rot, [0, -90, -180], [0, 0.55, 0])
  const lift = useTransform(rot, [0, -90, -180], [0, 0.35, 0])

  // Layout effect: the leaf must sit at its starting angle before the first
  // paint, or a backwards turn flashes the page it is about to bring in.
  React.useLayoutEffect(() => {
    if (!turn) return undefined
    const start = turn.dir === 1 ? 0 : -180
    const end = turn.dir === 1 ? -180 : 0
    rot.set(start)
    const controls = animate(rot, end, { duration: 0.78, ease: [0.45, 0.05, 0.25, 1] })
    let alive = true
    void controls.then(() => {
      if (!alive) return
      setShown(turn.to)
      setTurn(null)
    })
    return () => {
      alive = false
      controls.stop()
    }
  }, [turn, rot])

  // Swipe to turn. A swipe never also counts as a tap on a pocket.
  const down = React.useRef<{ x: number; y: number } | null>(null)
  const swiped = React.useRef(false)
  function onPointerDown(e: React.PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return
    down.current = { x: e.clientX, y: e.clientY }
    swiped.current = false
  }
  function onPointerUp(e: React.PointerEvent) {
    const d = down.current
    down.current = null
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      swiped.current = true
      onSwipe(dx < 0 ? 1 : -1)
    }
  }
  function onClickCapture(e: React.MouseEvent) {
    if (swiped.current) {
      e.preventDefault()
      e.stopPropagation()
      swiped.current = false
    }
  }

  const page_ = (i: number, live: boolean) =>
    i >= 0 && i < count ? (
      renderPage(i, live)
    ) : (
      <div className="bx-page bx-page-blank" aria-hidden="true" />
    )

  const step = spread ? 2 : 1
  let left: React.ReactNode
  let right: React.ReactNode = null
  let leafFront: React.ReactNode = null
  let leafBack: React.ReactNode = null

  if (!turn) {
    left = page_(shown, true)
    right = spread ? page_(shown + 1, true) : null
  } else if (spread) {
    if (turn.dir === 1) {
      left = page_(turn.from, false)
      right = page_(turn.to + 1, false)
      leafFront = page_(turn.from + 1, false)
      leafBack = page_(turn.to, false)
    } else {
      left = page_(turn.to, false)
      right = page_(turn.from + 1, false)
      leafFront = page_(turn.to + 1, false)
      leafBack = page_(turn.from, false)
    }
  } else if (turn.dir === 1) {
    left = page_(turn.to, false)
    leafFront = page_(turn.from, false)
    leafBack = <div className="bx-page bx-page-back" aria-hidden="true" />
  } else {
    left = page_(turn.from, false)
    leafFront = page_(turn.to, false)
    leafBack = <div className="bx-page bx-page-back" aria-hidden="true" />
  }

  return (
    <div
      className={`bx-book ${spread ? "spread" : "single"} ${turn ? "turning" : ""}`}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (down.current = null)}
      onClickCapture={onClickCapture}
      data-step={step}
    >
      <div className="bx-book-half left">
        {left}
        {turn ? <motion.i className="bx-shade" style={{ opacity: lift }} /> : null}
      </div>
      {spread ? (
        <>
          <div className="bx-rings" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <div className="bx-book-half right">
            {right}
            {turn ? <motion.i className="bx-shade" style={{ opacity: lift }} /> : null}
          </div>
        </>
      ) : null}
      {turn ? (
        <motion.div className="bx-leaf" style={{ rotateY: rot }} aria-hidden="true">
          <div className="bx-leaf-face front">
            {leafFront}
            <motion.i className="bx-shade" style={{ opacity: shade }} />
          </div>
          <div className="bx-leaf-face back">
            {leafBack}
            <motion.i className="bx-shade" style={{ opacity: shade }} />
          </div>
        </motion.div>
      ) : null}
    </div>
  )
}
