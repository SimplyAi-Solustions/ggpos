/**
 * Code 128 (code set B), as whole modules, for the price label's barcode.
 *
 * Written here rather than pulled in from bwip-js so the label stays plain
 * data: the layout decides how many printer dots one module is, and the
 * painter fills whole-dot rectangles, so every bar lands on the D110's 8
 * dots a millimetre with no scaling and no smoothing. Code set B covers
 * printable ASCII, which is every character a Vault SKU can have.
 */
import { encodeCode } from "@gg/shared"

/**
 * Bar and space widths, in modules, for values 0 to 106 (106 is Stop).
 * Each pattern starts with a bar and alternates; every pattern is 11 modules
 * wide, Stop 13.
 */
export const PATTERNS: readonly string[] = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
]

const START_B = 104
const STOP = 106

/** The symbol values for `text` in code set B, with the start, check and stop. */
export function code128Values(text: string): number[] {
  const values = [START_B]
  for (const char of text) {
    const code = char.charCodeAt(0)
    if (char.length !== 1 || code < 32 || code > 126) {
      throw new Error(`Code 128 B cannot carry "${char}"`)
    }
    values.push(code - 32)
  }
  let sum = START_B
  for (let i = 1; i < values.length; i++) sum += (values[i] as number) * i
  values.push(sum % 103, STOP)
  return values
}

/** Every module left to right: true is a bar. No quiet zone. */
export function code128Modules(text: string): boolean[] {
  const modules: boolean[] = []
  for (const value of code128Values(text)) {
    const pattern = PATTERNS[value] as string
    for (let i = 0; i < pattern.length; i++) {
      const bar = i % 2 === 0
      for (let n = 0; n < Number(pattern[i]); n++) modules.push(bar)
    }
  }
  return modules
}

/** The quiet zone each side, in modules, that the standard asks for. */
export const QUIET_ZONE = 10

/**
 * What the till scans: the SKU in its encoded form, no hyphen
 * (GGS-7F3K2Q prints as GGS7F3K2Q). The shop Mac sync sends the same value
 * to Epos Now as the product's Barcode (deploy/mac/lib/epos-stock.mjs, which
 * calls the same encodeCode through pb_hooks/lib/shared/sku.js).
 */
export function eposBarcode(sku: string): string {
  return encodeCode(sku)
}
