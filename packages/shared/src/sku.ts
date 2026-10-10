/**
 * Codes printed on labels and cards.
 *
 * Shape: "GG" + kind letter + 5 body characters + 1 check character, all from
 * the Crockford base32 alphabet (no I, L, O, U). Displayed with a hyphen after
 * the kind letter (GGS-7F3K2Q), encoded in QR codes without it (GGS7F3K2Q).
 *
 * Kind letters: S single, G graded, R retro, P sealed product, A accessory,
 * X other, C customer, V reward voucher. The scan listener routes by kind.
 */

export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

export const CODE_KINDS = {
  single: "S",
  graded: "G",
  retro: "R",
  sealed: "P",
  accessory: "A",
  other: "X",
  customer: "C",
  voucher: "V",
} as const

export type CodeKindName = keyof typeof CODE_KINDS
export type CodeKindLetter = (typeof CODE_KINDS)[CodeKindName]

const KIND_LETTERS = new Set<string>(Object.values(CODE_KINDS))
const BODY_LENGTH = 5
const PREFIX = "GG"

export interface ParsedCode {
  kind: CodeKindName
  letter: CodeKindLetter
  body: string
  check: string
  /** Bare form without hyphen, for example GGS7F3K2Q. */
  encoded: string
  /** Display form, for example GGS-7F3K2Q. */
  display: string
}

function valueOf(char: string): number {
  const index = CROCKFORD_ALPHABET.indexOf(char)
  if (index < 0) throw new Error(`Character not in alphabet: ${char}`)
  return index
}

/**
 * Weighted mod-32 check over kind letter + body. Weights rise with position so
 * an adjacent transposition changes the result.
 */
export function computeCheckChar(letter: string, body: string): string {
  const chars = letter + body
  let sum = 0
  for (let i = 0; i < chars.length; i++) {
    sum += valueOf(chars[i] as string) * (i + 1)
  }
  return CROCKFORD_ALPHABET[sum % 32] as string
}

/**
 * Normalise scanned or typed input: uppercase, drop hyphens and spaces, and
 * apply Crockford's decode rules (I and L read as 1, O reads as 0).
 */
export function normaliseCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[-\s]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
}

export function kindFromLetter(letter: string): CodeKindName | null {
  const entry = (Object.entries(CODE_KINDS) as [CodeKindName, CodeKindLetter][]).find(
    ([, l]) => l === letter
  )
  return entry ? entry[0] : null
}

/** Parse and validate a code. Returns null when the shape or check fails. */
export function parseCode(input: string): ParsedCode | null {
  const encoded = normaliseCode(input)
  if (encoded.length !== PREFIX.length + 1 + BODY_LENGTH + 1) return null
  if (!encoded.startsWith(PREFIX)) return null
  const letter = encoded[2] as string
  if (!KIND_LETTERS.has(letter)) return null
  const body = encoded.slice(3, 3 + BODY_LENGTH)
  const check = encoded[3 + BODY_LENGTH] as string
  for (const ch of body + check) {
    if (!CROCKFORD_ALPHABET.includes(ch)) return null
  }
  if (computeCheckChar(letter, body) !== check) return null
  const kind = kindFromLetter(letter)
  if (!kind) return null
  return {
    kind,
    letter: letter as CodeKindLetter,
    body,
    check,
    encoded,
    display: `${PREFIX}${letter}-${body}${check}`,
  }
}

export function isValidCode(input: string): boolean {
  return parseCode(input) !== null
}

/** Build a code from a kind and a 5-character body (adds the check character). */
export function buildCode(kind: CodeKindName, body: string): ParsedCode {
  if (body.length !== BODY_LENGTH) throw new Error(`Body must be ${BODY_LENGTH} characters`)
  const letter = CODE_KINDS[kind]
  const check = computeCheckChar(letter, body)
  const parsed = parseCode(`${PREFIX}${letter}${body}${check}`)
  if (!parsed) throw new Error("Built code failed to parse")
  return parsed
}

/**
 * Generate a random code of a kind using the supplied random source
 * (defaults to crypto.getRandomValues; hooks pass their own source).
 */
export function generateCode(
  kind: CodeKindName,
  randomByte: () => number = defaultRandomByte
): ParsedCode {
  let body = ""
  while (body.length < BODY_LENGTH) {
    const byte = randomByte()
    // 256 is a multiple of 32, so masking gives a uniform index.
    body += CROCKFORD_ALPHABET[byte & 31] as string
  }
  return buildCode(kind, body)
}

function defaultRandomByte(): number {
  const bytes = new Uint8Array(1)
  globalThis.crypto.getRandomValues(bytes)
  return bytes[0] as number
}

/** Display form (with hyphen) for any valid encoded code; input returned as-is when invalid. */
export function displayCode(input: string): string {
  return parseCode(input)?.display ?? input
}

/** Encoded form (no hyphen) for QR codes. */
export function encodeCode(input: string): string {
  return parseCode(input)?.encoded ?? normaliseCode(input)
}
