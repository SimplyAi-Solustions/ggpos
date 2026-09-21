/**
 * The four label layouts, from docs/label-spec.md.
 *
 * The spec is written in pixels at 203 dpi because that is what the ORGSTA
 * T003 prints; the page itself is laid out in millimetres, so a browser print
 * comes out the right physical size whatever the screen's own dpi is. Both
 * figures are returned here, from one table, so the two can never drift.
 *
 * Pure: no React, no DOM, so the layout is unit tested on its own.
 */
import { displayCode, formatGBP } from "@gg/shared"

import type { LabelJobDetail, LabelTemplateKey } from "@/lib/api/types"

/** 203 / 25.4 = 7.992 dots per millimetre. */
export const DOTS_PER_MM = 203 / 25.4

export function pxToMm(px: number): number {
  return Math.round((px / DOTS_PER_MM) * 100) / 100
}

export interface LabelSpec {
  widthMm: number
  heightMm: number
  /** Whole dots at 203 dpi, as the spec's table prints them. */
  widthPx: number
  heightPx: number
  qrPx: number
}

export const LABEL_SPECS: Record<LabelTemplateKey, LabelSpec> = {
  toploader_40x20: { widthMm: 40, heightMm: 20, widthPx: 320, heightPx: 160, qrPx: 110 },
  sleeve_25x15: { widthMm: 25, heightMm: 15, widthPx: 200, heightPx: 120, qrPx: 88 },
  retro_50x30: { widthMm: 50, heightMm: 30, widthPx: 400, heightPx: 240, qrPx: 150 },
  customer_card_80x50: {
    widthMm: 80,
    heightMm: 50,
    widthPx: 640,
    heightPx: 400,
    qrPx: 260,
  },
}

export type LabelLineRole =
  | "title"
  | "detail"
  | "condition"
  | "price"
  | "code"
  | "tier"

export interface LabelLine {
  role: LabelLineRole
  text: string
}

export interface LabelLayout {
  template: LabelTemplateKey
  spec: LabelSpec
  /** The QR's side in millimetres, converted from the spec's dots. */
  qrMm: number
  /** What the QR encodes: the bare code, or a portal link for a card. */
  qrText: string
  /** In the order the spec puts them down the label. */
  lines: LabelLine[]
  /** Only the sleeve has no room for a title, so only it hides the mark. */
  showMark: boolean
  /** Type scale for this size, in millimetres. */
  titleMm: number
  metaMm: number
  priceMm: number
}

/**
 * The room left for text beside the QR, in millimetres: the label less its
 * side padding, the QR and the gap between the two.
 */
export function textWidthMm(spec: LabelSpec): number {
  const padding = 1.5 * 2
  const gap = 1.5
  return Math.max(4, spec.widthMm - padding - pxToMm(spec.qrPx) - gap)
}

/**
 * Shrink a title until the whole of it fits the label's text column.
 *
 * A 40 x 20 mm label that clips "Mabel, Heir to Cra..." is worse at the
 * counter than one that prints the whole name a little smaller, so the type
 * gives way rather than the words. 0.52em is the average glyph width of Jost
 * at medium weight; the floor keeps it readable on thermal paper.
 */
export function fitTitleMm(
  text: string,
  startMm: number,
  widthMm: number,
  floorMm = 1.6
): number {
  const perChar = 0.52
  if (text.length === 0) return startMm
  const fits = widthMm / (text.length * perChar)
  const size = Math.min(startMm, Math.max(floorMm, fits))
  return Math.round(size * 100) / 100
}

/**
 * A customer card's QR opens the portal; every other label carries the code.
 *
 * A job claimed from the print queue arrives with the server's own
 * `qr_text`, which wins: the server is the authority on what a label
 * carries, and a queue built by one version of the app can be printed by
 * another.
 */
export function qrTextFor(job: LabelJobDetail, portalBase: string): string {
  if (job.qrText) return job.qrText
  if (job.template === "customer_card_80x50") {
    return `${portalBase.replace(/\/$/, "")}/c/${job.code}`
  }
  return job.code
}

/**
 * The template, the sizes and the lines of text for one queued job.
 *
 * Top loader and boxed retro carry the title, the set line, the condition and
 * the price. The sleeve is a QR with the code under it, because 25 x 15 mm has
 * no room for anything else and staff scan it instead of reading it. The
 * customer card carries the name, the code and the tier.
 */
export function labelLayout(
  job: LabelJobDetail,
  portalBase = "https://vault.ggentertainment.co.uk"
): LabelLayout {
  const template = job.template
  const spec = LABEL_SPECS[template] ?? LABEL_SPECS.toploader_40x20
  const base: Omit<LabelLayout, "lines" | "showMark" | "titleMm" | "metaMm" | "priceMm"> = {
    template,
    spec,
    qrMm: pxToMm(spec.qrPx),
    qrText: qrTextFor(job, portalBase),
  }

  if (template === "sleeve_25x15") {
    return {
      ...base,
      lines: [{ role: "code", text: displayCode(job.code) }],
      showMark: false,
      titleMm: 2,
      metaMm: 1.8,
      priceMm: 2.4,
    }
  }

  if (template === "customer_card_80x50") {
    return {
      ...base,
      lines: [
        { role: "title", text: job.title },
        { role: "code", text: displayCode(job.code) },
        { role: "tier", text: job.detail },
      ],
      showMark: true,
      titleMm: fitTitleMm(job.title, 5, textWidthMm(spec), 2.6),
      metaMm: 3.2,
      priceMm: 3.2,
    }
  }

  const big = template === "retro_50x30"
  const lines: LabelLine[] = [{ role: "title", text: job.title }]
  if (job.detail) lines.push({ role: "detail", text: job.detail })
  if (job.condition) lines.push({ role: "condition", text: job.condition })
  lines.push({ role: "price", text: formatGBP(job.price) })

  return {
    ...base,
    lines,
    showMark: true,
    titleMm: fitTitleMm(job.title, big ? 3.6 : 2.6, textWidthMm(spec)),
    metaMm: big ? 2.6 : 2,
    priceMm: big ? 4.4 : 3.4,
  }
}

/**
 * The next print run, and what is left after it.
 *
 * `@page` takes one size and the printer has one roll loaded, so a queue of
 * mixed templates goes in batches. The oldest job leads, because that is the
 * one that has been waiting longest.
 */
export interface PrintBatch {
  template: LabelTemplateKey | null
  jobs: LabelJobDetail[]
  /** How many queued jobs are on some other label size. */
  waiting: number
}

export function nextPrintBatch(queued: LabelJobDetail[]): PrintBatch {
  const oldest = [...queued].sort((a, b) =>
    a.requestedAt.localeCompare(b.requestedAt)
  )[0]
  if (!oldest) return { template: null, jobs: [], waiting: 0 }
  const jobs = queued.filter((job) => job.template === oldest.template)
  return {
    template: oldest.template,
    jobs,
    waiting: queued.length - jobs.length,
  }
}
