/**
 * Stand-in product art for the kit page, drawn as inline SVG data URIs so the
 * kit needs no binary fixtures.
 *
 * `cardArt` is a cut-out with rounded corners and a transparent background, so
 * the `shadow` finish's drop-shadow follows the card's real edge. `boxArt`
 * fills its frame edge to edge, which is what the `edge` finish expects.
 */

const INK = "#0b0b0b"

function dataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg.replace(/\s+/g, " ").trim())}`
}

/** A card: rounded corners, transparent surround, one art window. */
export function cardArt([w, h]: readonly [number, number]): string {
  const r = Math.max(2, Math.round(Math.min(w, h) * 0.05))
  const pad = Math.round(Math.min(w, h) * 0.08)
  const artH = Math.round(h * 0.46)
  return dataUri(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
      <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="${r}"
        fill="#ffffff" stroke="${INK}" stroke-opacity="0.14" stroke-width="1"/>
      <rect x="${pad}" y="${pad * 1.6}" width="${w - pad * 2}" height="${artH}"
        fill="${INK}" fill-opacity="0.07"/>
      <rect x="${pad}" y="${pad * 1.6 + artH + pad * 0.7}" width="${(w - pad * 2) * 0.72}"
        height="${Math.max(2, h * 0.022)}" fill="${INK}" fill-opacity="0.16"/>
      <rect x="${pad}" y="${pad * 1.6 + artH + pad * 1.5}" width="${(w - pad * 2) * 0.46}"
        height="${Math.max(2, h * 0.022)}" fill="${INK}" fill-opacity="0.1"/>
      <rect x="${pad}" y="${h - pad - Math.max(2, h * 0.022)}" width="${(w - pad * 2) * 0.3}"
        height="${Math.max(2, h * 0.022)}" fill="${INK}" fill-opacity="0.1"/>
    </svg>
  `)
}

/** Box art: opaque to the frame edge, with a printed spine band. */
export function boxArt([w, h]: readonly [number, number]): string {
  const band = Math.round(h * 0.18)
  const pad = Math.round(Math.min(w, h) * 0.1)
  return dataUri(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
      <rect width="${w}" height="${h}" fill="#e8e8e2"/>
      <rect width="${w}" height="${band}" fill="${INK}" fill-opacity="0.12"/>
      <rect x="${pad}" y="${band + pad}" width="${w - pad * 2}" height="${h - band - pad * 2.4}"
        fill="${INK}" fill-opacity="0.06"/>
      <rect x="${pad}" y="${h - pad - Math.max(2, h * 0.03)}" width="${(w - pad * 2) * 0.55}"
        height="${Math.max(2, h * 0.03)}" fill="${INK}" fill-opacity="0.14"/>
    </svg>
  `)
}
