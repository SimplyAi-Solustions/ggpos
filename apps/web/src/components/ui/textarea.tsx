import * as React from "react"
import { cn } from "cn"

type TextareaProps = React.ComponentProps<"textarea"> & {
  /** Right-aligned micro-text, usually a character count: "0 / 200". */
  trailingHint?: React.ReactNode
  containerClassName?: string
}

/** Grows with its content in every browser, not only the ones with field-sizing. */
function useAutoGrow(ref: React.RefObject<HTMLTextAreaElement | null>, value: unknown) {
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (CSS.supports("field-sizing", "content")) return
    el.style.height = "auto"
    el.style.height = `${el.scrollHeight}px`
  }, [ref, value])
}

/** The Input underline treatment, on a box that grows as you type. */
function Textarea({
  className,
  containerClassName,
  trailingHint,
  onChange,
  ref,
  ...props
}: TextareaProps) {
  const innerRef = React.useRef<HTMLTextAreaElement>(null)
  const [shadowValue, setShadowValue] = React.useState(props.defaultValue ?? "")
  React.useImperativeHandle(ref, () => innerRef.current as HTMLTextAreaElement)
  useAutoGrow(innerRef, props.value ?? shadowValue)

  const invalid = props["aria-invalid"] === true || props["aria-invalid"] === "true"

  return (
    <div
      data-slot="textarea-root"
      data-invalid={invalid || undefined}
      data-disabled={props.disabled || undefined}
      className={cn(
        "group/input relative flex w-full items-end gap-3 pt-1 pb-2 data-disabled:opacity-50",
        containerClassName
      )}
    >
      <textarea
        ref={innerRef}
        rows={1}
        data-slot="textarea"
        onChange={(event) => {
          setShadowValue(event.target.value)
          onChange?.(event)
        }}
        className={cn(
          "field-sizing-content min-h-6 w-full flex-1 resize-none border-0 bg-transparent p-0 text-base leading-[1.5] text-foreground caret-foreground outline-none",
          "placeholder:text-muted-foreground-2 disabled:cursor-not-allowed",
          className
        )}
        {...props}
      />

      {trailingHint ? (
        <span
          data-slot="textarea-trailing-hint"
          className="shrink-0 pb-1 pl-4 text-right font-mono text-[11px] leading-[1.4] font-bold tracking-[0.16em] text-muted-foreground-2 uppercase group-data-[invalid]/input:text-destructive"
        >
          {trailingHint}
        </span>
      ) : null}

      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-hairline"
      />
      <span
        aria-hidden="true"
        data-slot="input-underline"
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 h-[1.5px] origin-left scale-x-0 bg-volt",
          "transition-transform duration-150 ease-gg",
          "group-focus-within/input:scale-x-100",
          "group-data-[invalid]/input:scale-x-100 group-data-[invalid]/input:bg-pop"
        )}
      />
    </div>
  )
}

export { Textarea }
export type { TextareaProps }
