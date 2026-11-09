/**
 * The GG mark on a needed card the shop has on the shelf. The card stays
 * greyed; the badge is the one thing in full colour, with a slow glow that
 * prefers-reduced-motion turns off (binders.css). It never says more than
 * "it is in the shop": no price, no quantity.
 */
export function InStockBadge() {
  return (
    <span className="bx-instock" role="img" aria-label="In stock at GG Entertainment" title="In stock at GG Entertainment">
      <img src="/icon.svg" alt="" draggable={false} />
    </span>
  )
}
