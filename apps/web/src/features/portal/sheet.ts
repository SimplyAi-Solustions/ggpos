/**
 * The column a portal sheet's content keeps.
 *
 * `SheetContent side="bottom"` docks full width at every size, which is right
 * on a phone and wrong at 1440: the rest of My Vault is a narrow centred
 * column, and a full-bleed panel under it reads as a different product. The
 * panel still spans the window, so the animation and the safe-area inset are
 * the shared component's; only the text inside it is brought back to the
 * column.
 */
export const SHEET_COLUMN = "mx-auto w-full max-w-[560px]"
