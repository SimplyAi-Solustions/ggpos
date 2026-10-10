/**
 * The day view's geometry: where the hours sit down the side, where a
 * booking's block lands in its column, how blocks that overlap share a
 * column, and where a dragged block is dropped.
 *
 * Pure, and in pixels and epoch milliseconds only, so the day view's
 * arithmetic is unit tested without a DOM. Every clock reading is the
 * shop's own (`shopClock`), whatever the browser's time zone.
 */
import { shopClock, type Availability, type BusyWindow } from "@gg/shared"

/** One hour of the day view, tall enough to tap a slot with a thumb. */
export const HOUR_PX = 72
export const PX_PER_MINUTE = HOUR_PX / 60

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** The top and the bottom of the grid, epoch milliseconds. */
export interface Frame {
  start: number
  end: number
}

/**
 * The grid runs from the first slot anybody can book to the last one ends,
 * on whole hours. Null on a day nothing is open.
 */
export function frameFor(availability: Pick<Availability, "resources"> | undefined): Frame | null {
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (const entry of availability?.resources ?? []) {
    for (const slot of entry.slots) {
      start = Math.min(start, Date.parse(slot.starts_at))
      end = Math.max(end, Date.parse(slot.ends_at))
    }
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  // Shop time is UTC or UTC+1, so a whole UTC hour is a whole shop hour.
  return { start: Math.floor(start / HOUR) * HOUR, end: Math.ceil(end / HOUR) * HOUR }
}

export function frameHeight(frame: Frame, scale = PX_PER_MINUTE): number {
  return ((frame.end - frame.start) / MINUTE) * scale
}

/** The hour lines and their labels, "10:00" to the last hour before closing. */
export function hourMarks(frame: Frame, scale = PX_PER_MINUTE): { top: number; label: string; at: string }[] {
  const marks: { top: number; label: string; at: string }[] = []
  for (let t = frame.start; t < frame.end; t += HOUR) {
    const at = new Date(t).toISOString()
    marks.push({ top: ((t - frame.start) / MINUTE) * scale, label: shopClock(at), at })
  }
  return marks
}

/** A window's box in its column, clipped to the grid. Null when it is off the grid. */
export function blockBox(
  window: BusyWindow,
  frame: Frame,
  scale = PX_PER_MINUTE
): { top: number; height: number } | null {
  const start = Math.max(frame.start, Date.parse(window.starts_at))
  const end = Math.min(frame.end, Date.parse(window.ends_at))
  if (!(end > start)) return null
  return {
    top: ((start - frame.start) / MINUTE) * scale,
    height: ((end - start) / MINUTE) * scale,
  }
}

/** Where "now" is on the grid, or null when it is not on today's grid. */
export function nowTop(frame: Frame, now: number, scale = PX_PER_MINUTE): number | null {
  if (now < frame.start || now > frame.end) return null
  return ((now - frame.start) / MINUTE) * scale
}

export interface Placed<T> {
  item: T
  /** Which lane of its cluster, from 0. */
  lane: number
  /** How many lanes its cluster needs. */
  lanes: number
}

/**
 * Blocks that overlap share their column side by side. Items are grouped
 * into clusters of blocks that overlap one another directly or through a
 * neighbour; inside a cluster each block takes the first lane free at its
 * start, and every block in the cluster is as narrow as the busiest moment
 * needs. Blocks that only touch (one ends as the next starts) do not
 * overlap.
 */
export function laneLayout<T extends BusyWindow>(items: readonly T[]): Placed<T>[] {
  const sorted = [...items].sort(
    (a, b) =>
      Date.parse(a.starts_at) - Date.parse(b.starts_at) || Date.parse(b.ends_at) - Date.parse(a.ends_at)
  )
  const placed: Placed<T>[] = []
  let cluster: Placed<T>[] = []
  let laneEnds: number[] = []
  let clusterEnd = Number.NEGATIVE_INFINITY

  const close = () => {
    const lanes = Math.max(1, laneEnds.length)
    for (const entry of cluster) entry.lanes = lanes
    placed.push(...cluster)
    cluster = []
    laneEnds = []
  }

  for (const item of sorted) {
    const start = Date.parse(item.starts_at)
    const end = Date.parse(item.ends_at)
    if (cluster.length > 0 && start >= clusterEnd) close()
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start)
    if (lane < 0) {
      lane = laneEnds.length
      laneEnds.push(end)
    } else {
      laneEnds[lane] = end
    }
    cluster.push({ item, lane, lanes: 1 })
    clusterEnd = cluster.length === 1 ? end : Math.max(clusterEnd, end)
  }
  if (cluster.length > 0) close()
  return placed
}

export interface DropInput {
  /** The block's own window. */
  startMs: number
  endMs: number
  /** The column it was picked up from, and how many there are. */
  columnIndex: number
  columnCount: number
  columnWidth: number
  /** How far the pointer has moved since it was picked up. */
  dx: number
  dy: number
  /** Snap to this many minutes, counted from the top of the grid. */
  stepMinutes: number
  frame: Frame
  scale?: number
}

export interface DropTarget {
  columnIndex: number
  startMs: number
  endMs: number
  /** Nothing would change. */
  same: boolean
}

/**
 * Where a dragged block lands: the column under it, and its start snapped
 * to the step and kept inside the grid. Its length never changes.
 */
export function dropTarget(input: DropInput): DropTarget {
  const scale = input.scale ?? PX_PER_MINUTE
  const step = Math.max(5, input.stepMinutes)
  const length = input.endMs - input.startMs
  const columnIndex = Math.min(
    Math.max(0, input.columnIndex + Math.round(input.dx / Math.max(1, input.columnWidth))),
    Math.max(0, input.columnCount - 1)
  )
  const fromTop = (input.startMs - input.frame.start) / MINUTE + input.dy / scale
  const snapped = Math.round(fromTop / step) * step
  const latest = (input.frame.end - input.frame.start - length) / MINUTE
  const minutes = Math.min(Math.max(0, snapped), Math.max(0, latest))
  const startMs = input.frame.start + minutes * MINUTE
  return {
    columnIndex,
    startMs,
    endMs: startMs + length,
    same: columnIndex === input.columnIndex && startMs === input.startMs,
  }
}

/** A pointer that has moved this far has started a drag rather than a tap. */
export const DRAG_THRESHOLD_PX = 6

export function isDrag(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX
}
