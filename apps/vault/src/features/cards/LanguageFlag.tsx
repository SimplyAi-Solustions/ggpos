import { cn } from "@/lib/cn"

import { languageName } from "./format"

/**
 * A small drawn flag plus the language code, so the language never rests on
 * colour or an emoji alone. Unknown languages show the code only.
 */
const CODES: Record<string, string> = {
  en: "EN",
  ja: "JP",
  ko: "KR",
  "zh-tw": "TC",
  "zh-cn": "SC",
  zh: "CN",
  fr: "FR",
  de: "DE",
  it: "IT",
  es: "ES",
  pt: "PT",
  th: "TH",
}

function Tricolour({ colours, vertical = true }: { colours: [string, string, string]; vertical?: boolean }) {
  return (
    <>
      {colours.map((fill, i) =>
        vertical ? (
          <rect key={i} x={i * 6} y={0} width={6} height={12} fill={fill} />
        ) : (
          <rect key={i} x={0} y={i * 4} width={18} height={4} fill={fill} />
        )
      )}
    </>
  )
}

function FlagShape({ code }: { code: string }) {
  switch (code) {
    case "en":
      return (
        <>
          <rect width={18} height={12} fill="#012169" />
          <path d="M0 0L18 12M18 0L0 12" stroke="#fff" strokeWidth={2.4} />
          <path d="M0 0L18 12M18 0L0 12" stroke="#C8102E" strokeWidth={0.9} />
          <path d="M9 0V12M0 6H18" stroke="#fff" strokeWidth={3.6} />
          <path d="M9 0V12M0 6H18" stroke="#C8102E" strokeWidth={2} />
        </>
      )
    case "ja":
      return (
        <>
          <rect width={18} height={12} fill="#fff" />
          <circle cx={9} cy={6} r={3.4} fill="#BC002D" />
        </>
      )
    case "ko":
      return (
        <>
          <rect width={18} height={12} fill="#fff" />
          <path d="M6 6a3 3 0 0 1 6 0z" fill="#CD2E3A" />
          <path d="M6 6a3 3 0 0 0 6 0z" fill="#0047A0" />
        </>
      )
    case "zh":
    case "zh-cn":
    case "zh-tw":
      return (
        <>
          <rect width={18} height={12} fill={code === "zh-tw" ? "#FE0000" : "#DE2910"} />
          <circle cx={4} cy={3.6} r={1.8} fill={code === "zh-tw" ? "#fff" : "#FFDE00"} />
        </>
      )
    case "fr":
      return <Tricolour colours={["#002395", "#fff", "#ED2939"]} />
    case "it":
      return <Tricolour colours={["#009246", "#fff", "#CE2B37"]} />
    case "de":
      return <Tricolour colours={["#000", "#DD0000", "#FFCE00"]} vertical={false} />
    case "es":
      return (
        <>
          <rect width={18} height={12} fill="#AA151B" />
          <rect y={3} width={18} height={6} fill="#F1BF00" />
        </>
      )
    default:
      return null
  }
}

export function LanguageFlag({ language, className }: { language: string; className?: string }) {
  const code = (language || "en").toLowerCase()
  const label = CODES[code] ?? code.toUpperCase().slice(0, 3)
  const shape = FlagShape({ code })
  return (
    <span className={cn("inline-flex items-center gap-1 font-mono text-[11px] font-bold text-fg-2", className)} title={languageName(code)}>
      {shape && (
        <svg viewBox="0 0 18 12" className="h-[10px] w-[15px] shrink-0 rounded-[2px] ring-1 ring-line-2" aria-hidden>
          {shape}
        </svg>
      )}
      <span aria-label={languageName(code)}>{label}</span>
    </span>
  )
}
