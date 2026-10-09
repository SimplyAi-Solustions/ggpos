/**
 * The till (`/counter/till`): the shop's EPOS, stood at all day on an
 * Android tablet and a Mac, and on a phone when it has to be (DESIGN.md,
 * section 10; docs/EPOS-PLAN.md, "The till screen").
 *
 * Full bleed. From 900px the catalogue and the ticket sit side by side;
 * below that they are two tabs with the total and Pay docked under both.
 * Pay turns the catalogue into the tender pane and the ticket goes read
 * only; when nothing is left to pay the sale completes on its own, and the
 * done view offers the receipt.
 *
 * Wedge-scanner first: an item, a stock line's barcode, a customer card, a
 * reward voucher and a receipt all land in the one field and are told apart
 * by their shape. The ticket lives outside React (`till-store.ts`), so a
 * lock, a change of user and a reload all leave it where it was.
 */
import * as React from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ClientResponseError } from "pocketbase"
import {
  formatGBP,
  type Capability,
  type TillCatalogueItem,
  type TillCatalogueProduct,
} from "@gg/shared"

import { Button } from "@/components/ui/button"
import { MicroLabel } from "@/components/ui/micro-label"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useScanPulse } from "@/design/motion"
import { registerScanField } from "@/app/focus-registry"
import { setScanHandler } from "@/app/scan-bus"
import { OverrideCancelled } from "@/features/lock/override"
import { openDrawer, printReceipt } from "@/features/printing/receipt"
import { CustomerSearchSheet } from "@/features/sell/CustomerSearchSheet"
import { CataloguePane } from "@/features/till/CataloguePane"
import { DonePane, type ReceiptChoice } from "@/features/till/DonePane"
import { ReturnsSheet } from "@/features/till/ReturnsSheet"
import { TenderPane } from "@/features/till/TenderPane"
import { TicketPane } from "@/features/till/TicketPane"
import { TillHeader } from "@/features/till/TillHeader"
import { useEposSettings } from "@/features/till/epos-settings"
import { readTillScan, worthSearching } from "@/features/till/scan"
import {
  KeyPriceSheet,
  LineSheet,
  ParkSheet,
  RecallSheet,
  TicketDiscountSheet,
} from "@/features/till/sheets"
import {
  lineFromCatalogueItem,
  lineFromItem,
  lineFromProduct,
  lineNet,
  pointsPreview,
  saleLines,
  sameThing,
  stockIds,
  summarise,
  voucherProblem,
  type Ticket,
  type TicketLine,
  type TicketTotals,
} from "@/features/till/ticket"
import {
  resolveTenders,
  tenderInputs,
  tendersProblem,
} from "@/features/till/tenders"
import {
  dispatchTill,
  getTill,
  tillClientId,
  useTill,
  type DoneSale,
} from "@/features/till/till-store"
import { tillDisplayPayload, useTillDisplay } from "@/features/till/use-till-display"
import { useWide } from "@/features/till/use-wide"
import {
  getCustomerForSale,
  getItem,
  getVoucher,
  isQueuedSaleId,
  listItems,
} from "@/lib/api"
import { useCounterConfig } from "@/lib/api/config"
import { getVoucherByCode } from "@/lib/api/loyalty"
import { isNotFound, refusalMessage, refusalOrFallback } from "@/lib/api/refusal"
import {
  completeTillSale,
  deleteParkedTicket,
  emailReceipt,
  getTillCatalogue,
  listParkedTickets,
  parkTicket,
  tillProductByBarcode,
  voidTicketLines,
  type ParkedTicket,
  type TillSalePayload,
} from "@/lib/api/till"
import { currentRegisterId, useTillCurrent } from "@/lib/api/till-session"
import type { ItemDetail, ItemSummary, SaleCustomer } from "@/lib/api/types"

/** Panels own the pointer while they are open; the scan field must not fight them. */
const KEEPS_FOCUS =
  "input, textarea, select, button, a, [contenteditable='true'], [role='dialog'], [role='menu'], [data-slot='sheet-content'], [data-slot='dialog-content'], [data-slot='select-content'], [data-slot='menu-content']"

/**
 * A mouse or a trackpad: the Mac. Only there does the till hold the scan
 * field's focus between presses. On the tablet a focused field means the
 * on-screen keyboard over half the till; its Bluetooth scanner is caught by
 * the counter's wedge listener with no field focused at all.
 */
function finePointer(): boolean {
  try {
    return window.matchMedia?.("(pointer: fine)").matches ?? true
  } catch {
    return true
  }
}

let productLines = 0

/** A product line's own key: an open-price key can be on a ticket twice. */
function productKey(productId: string): string {
  productLines += 1
  return `product_${productId}_${Date.now().toString(36)}_${productLines}`
}

/** One line saying what a manager is being asked to approve. */
function approvalLine(capability: Capability, ticket: Ticket, totals: TicketTotals): string {
  switch (capability) {
    case "discount_over_limit":
      return `A discount of ${formatGBP(totals.lineDiscounts + totals.discount)} on a ticket of ${formatGBP(totals.gross)}`
    case "price_override": {
      const changed = ticket.lines.find((line) => line.unitPrice !== line.listPrice)
      return changed
        ? `${changed.title} at ${formatGBP(changed.unitPrice)} instead of ${formatGBP(changed.listPrice)}`
        : "A changed price on this ticket"
    }
    case "void_line":
      return "Lines taken off this ticket"
    default:
      return `A sale of ${formatGBP(totals.total)}`
  }
}

/** The request reached nobody: no answer to act on, so nothing to keep. */
function unanswered(error: unknown): boolean {
  if (error instanceof ClientResponseError) return error.status === 0
  return error instanceof TypeError
}

export interface TillScreenProps {
  /** A `GGV-` code handed over by the Scan screen's voucher sheet. */
  voucher?: string
}

export function TillScreen({ voucher: incomingVoucher }: TillScreenProps = {}) {
  const till = useTill()
  const { ticket, phase, tenders, step, done } = till
  const wide = useWide()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const scanRef = React.useRef<HTMLInputElement>(null)

  const settings = useEposSettings()
  const { data: config } = useCounterConfig()
  const setup = config?.loyalty
  const current = useTillCurrent({ running: false })

  const totals = summarise(ticket)
  const tenderState = resolveTenders(totals.total, tenders)
  const paidWithPoints = tenderState.tenders
    .filter((tender) => tender.method === "points")
    .reduce((sum, tender) => sum + tender.amount, 0)
  const points = pointsPreview(ticket, totals, setup, paidWithPoints)

  const registerId = current.data?.register.id ?? currentRegisterId() ?? ""
  const registerName = current.data?.register.name || "Counter"
  const closed = current.data ? current.data.session === null : false

  // ---- What the screen holds for itself -------------------------------

  const [tab, setTab] = React.useState<"items" | "ticket">("items")
  const [categoryId, setCategoryId] = React.useState<string | null>(null)
  const [search, setSearch] = React.useState<string | null>(null)
  const [scanError, setScanError] = React.useState<string | null>(null)
  const [scanNote, setScanNote] = React.useState<string | null>(null)
  const [saleError, setSaleError] = React.useState<string | null>(null)
  const [ticketNote, setTicketNote] = React.useState<string | null>(null)

  const [customerOpen, setCustomerOpen] = React.useState(false)
  const [pendingProduct, setPendingProduct] = React.useState<TillCatalogueProduct | null>(null)
  const [lineKey, setLineKey] = React.useState<string | null>(null)
  const [discountOpen, setDiscountOpen] = React.useState(false)
  const [keyPrice, setKeyPrice] = React.useState<TillCatalogueProduct | null>(null)
  const [parkOpen, setParkOpen] = React.useState(false)
  const [recallOpen, setRecallOpen] = React.useState(false)
  const [returns, setReturns] = React.useState<{ open: boolean; number: string }>({
    open: false,
    number: "",
  })

  const [receiptPending, setReceiptPending] = React.useState<ReceiptChoice | null>(null)
  const [receiptProblem, setReceiptProblem] = React.useState<string | null>(null)
  const [askEmail, setAskEmail] = React.useState(false)
  /** A receipt was chosen (or the drawer tried) for the sale on the done view. */
  const handled = React.useRef(false)

  const [pulsing, pulse] = useScanPulse()

  // ---- Reads -----------------------------------------------------------

  const catalogue = useQuery({
    queryKey: ["till-catalogue"],
    queryFn: getTillCatalogue,
    staleTime: 60_000,
  })
  const parked = useQuery({
    queryKey: ["till-parked", registerId],
    queryFn: () => listParkedTickets(registerId),
    enabled: Boolean(registerId),
    staleTime: 10_000,
    refetchInterval: 30_000,
  })
  const parkedTickets = React.useMemo(() => parked.data ?? [], [parked.data])

  /** Every read a sale moves, put back in step. */
  const settle = React.useCallback(() => {
    for (const key of [
      ["items"],
      ["item"],
      ["sales-today"],
      ["today-stats"],
      ["till-current"],
      ["till-category"],
      ["till-catalogue"],
      ["till-search-stock"],
    ]) {
      void queryClient.invalidateQueries({ queryKey: key })
    }
  }, [queryClient])

  // ---- The customer display --------------------------------------------

  const displayPayload = tillDisplayPayload({
    ticket,
    totals,
    points,
    phase,
    step,
    left: tenderState.left,
    done,
  })
  useTillDisplay(config?.display.enabled === true, displayPayload)

  // ---- Putting things on the ticket --------------------------------------

  const addLine = React.useCallback(
    (line: TicketLine) => {
      const now = getTill()
      if (now.phase === "paying") {
        setScanError("Finish taking payment, or go back to the ticket to add more.")
        return
      }
      const existing =
        now.phase === "done" ? undefined : now.ticket.lines.find((row) => sameThing(row, line))
      if (existing && existing.qty >= existing.maxQty) {
        setScanNote(`${line.title} is already on the ticket.`)
        pulse(existing.key)
        return
      }
      dispatchTill({ type: "add", line })
      pulse(existing?.key ?? line.key)
      setScanError(null)
      setScanNote(`${line.title} added`)
      setTicketNote(null)
    },
    [pulse]
  )

  const addItemDetail = React.useCallback(
    (item: ItemDetail) => {
      if (item.status === "sold" || item.status === "written_off" || (item.qty ?? 1) <= 0) {
        setScanError(`${item.title ?? "That item"} is no longer for sale.`)
        return
      }
      addLine(lineFromItem(item))
    },
    [addLine]
  )

  const addProduct = React.useCallback(
    (product: TillCatalogueProduct, price?: number, detail?: string) => {
      addLine(lineFromProduct(product, { key: productKey(product.id), price, detail }))
    },
    [addLine]
  )

  const chooseProduct = React.useCallback(
    (product: TillCatalogueProduct) => {
      if (product.kind === "membership" && !getTill().ticket.customer) {
        setPendingProduct(product)
        setScanNote(`Attach the customer to sell ${product.name}.`)
        setCustomerOpen(true)
        return
      }
      if (product.open_price || product.kind === "open_price") {
        setKeyPrice(product)
        return
      }
      addProduct(product)
    },
    [addProduct]
  )

  const chooseItem = React.useCallback(
    (item: TillCatalogueItem, label?: string) => addLine(lineFromCatalogueItem(item, label)),
    [addLine]
  )

  const chooseStock = React.useCallback(
    async (summary: ItemSummary) => {
      try {
        const item = await getItem(summary.sku)
        if (!item) {
          setScanError(`${summary.title} is not in stock any more.`)
          return
        }
        addItemDetail(item)
      } catch (error) {
        setScanError(refusalOrFallback(error, "That item could not be looked up. Try again."))
      }
    },
    [addItemDetail]
  )

  const attachCustomer = React.useCallback(
    (customer: SaleCustomer) => {
      dispatchTill({ type: "attachCustomer", customer })
      setScanNote(`${customer.name} attached`)
      if (pendingProduct) {
        addProduct(pendingProduct)
        setPendingProduct(null)
      }
    },
    [pendingProduct, addProduct]
  )

  /** A reward voucher: the refusal to show, or null once it is on the ticket. */
  const applyVoucher = React.useCallback(async (code: string): Promise<string | null> => {
    try {
      const voucher = await getVoucher(code)
      if (!voucher) return "That voucher has been used or has run out. Check the code."
      const now = getTill().ticket
      if (!now.customer) return "Scan the customer's card first, then their voucher."
      const problem = voucherProblem(voucher, now.customer, summarise(now).subtotal)
      if (problem) return problem
      dispatchTill({ type: "applyVoucher", voucher })
      setScanNote(`${voucher.rewardName} applied`)
      return null
    } catch (error) {
      return refusalOrFallback(error, "That voucher could not be looked up. Scan it again.")
    }
  }, [])

  const openReturns = React.useCallback((number: string) => {
    setReturns({ open: true, number })
  }, [])

  // ---- The scan field ---------------------------------------------------

  const commit = React.useCallback(
    async (raw: string) => {
      if (scanRef.current) scanRef.current.value = ""
      setScanError(null)
      setScanNote(null)
      const scan = readTillScan(raw)
      try {
        switch (scan.kind) {
          case "receipt": {
            if (scan.alsoItem) {
              const item = await getItem(scan.alsoItem)
              if (item) {
                addItemDetail(item)
                return
              }
            }
            openReturns(scan.number)
            return
          }
          case "item": {
            if (getTill().phase === "paying") {
              setScanError("Finish taking payment, or go back to the ticket to add more.")
              return
            }
            const item = await getItem(scan.sku)
            if (!item) {
              setScanError(`${scan.display} is not in stock. Check the label.`)
              return
            }
            addItemDetail(item)
            return
          }
          case "customer": {
            const customer = await getCustomerForSale(scan.code)
            if (!customer) {
              setScanError(`${scan.display} is not a customer here. Search by name instead.`)
              return
            }
            attachCustomer(customer)
            return
          }
          case "voucher": {
            const problem = await applyVoucher(scan.code)
            if (problem) setScanError(problem)
            return
          }
          case "ean": {
            const product = await tillProductByBarcode(scan.ean)
            if (product) {
              chooseProduct(product)
              return
            }
            const page = await listItems({ search: scan.ean, status: "in_stock" }, 1)
            const hit = page.items[0]
            const item = hit ? await getItem(hit.sku) : null
            if (!item) {
              setScanError("No stock has that barcode. Add it, or search by title.")
              return
            }
            addItemDetail(item)
            return
          }
          case "search":
            setSearch(scan.query)
            return
          default:
            setScanError(scan.message)
        }
      } catch (error) {
        setScanError(refusalOrFallback(error, "That code could not be looked up. Try again."))
      }
    },
    [addItemDetail, applyVoucher, attachCustomer, chooseProduct, openReturns]
  )

  React.useEffect(() => setScanHandler((raw) => void commit(raw)), [commit])

  // Live search on what is being typed, a moment after the typing stops.
  // A scanner's code is not words, so it never searches half-sent.
  const [typed, setTyped] = React.useState("")
  React.useEffect(() => {
    if (!worthSearching(typed)) return undefined
    const timer = window.setTimeout(() => setSearch(typed.trim()), 350)
    return () => window.clearTimeout(timer)
  }, [typed])

  const showCatalogue = phase === "ticket" && (wide || tab === "items")
  React.useEffect(() => {
    const field = scanRef.current
    if (!field || !showCatalogue) return undefined
    const unregister = registerScanField(field)
    if (!finePointer()) return unregister
    field.focus({ preventScroll: true })

    function reclaim(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest(KEEPS_FOCUS)) return
      if (document.querySelector("[data-slot='sheet-content'],[data-slot='dialog-content']")) return
      field?.focus({ preventScroll: true })
    }
    document.addEventListener("pointerup", reclaim)
    return () => {
      document.removeEventListener("pointerup", reclaim)
      unregister()
    }
  }, [showCatalogue])

  /**
   * A voucher handed over by the Scan screen's sheet. The sheet already
   * knows whose it is, so the customer comes with it. The code is taken out
   * of the address once it has been read, so a reload does not apply it
   * twice.
   */
  const claimed = React.useRef<string | null>(null)
  React.useEffect(() => {
    const code = incomingVoucher?.trim()
    if (!code || claimed.current === code) return
    claimed.current = code
    void (async () => {
      try {
        const detail = await getVoucherByCode(code)
        if (!detail) {
          setScanError("That voucher has been used or has run out. Check the code.")
          return
        }
        if (!getTill().ticket.customer) {
          const customer = await getCustomerForSale(detail.customer.code)
          if (customer) dispatchTill({ type: "attachCustomer", customer })
        }
        const problem = await applyVoucher(code)
        if (problem) setScanError(problem)
      } catch (error) {
        setScanError(refusalOrFallback(error, "That voucher could not be looked up. Scan it again."))
      } finally {
        void navigate({ to: "/counter/till", search: {}, replace: true })
      }
    })()
  }, [incomingVoucher, applyVoucher, navigate])

  // ---- Completing the sale -------------------------------------------------

  const sell = useMutation({
    mutationFn: async () => {
      const state = getTill()
      const sums = summarise(state.ticket)
      const paid = resolveTenders(sums.total, state.tenders)
      const problem = tendersProblem(sums.total, paid)
      if (problem) throw new Error(problem)
      const payload: TillSalePayload = {
        client_id: tillClientId(),
        lines: saleLines(state.ticket),
        discount: sums.discount,
        discount_source: sums.discountSource,
        reward_code: state.ticket.voucher?.code ?? null,
        customer: state.ticket.customer?.id ?? null,
        tenders: tenderInputs(paid),
        ...(state.ticket.voided.length ? { voided: state.ticket.voided } : {}),
      }
      const result = await completeTillSale(payload, (capability) =>
        approvalLine(capability, state.ticket, sums)
      )
      const sale: DoneSale = {
        saleId: result.sale.id,
        number: result.sale.number,
        total: result.sale.total,
        change: result.change ?? paid.change,
        pointsEarned: result.points_earned ?? 0,
        cash: paid.tenders.some((tender) => tender.method === "cash" && tender.amount > 0),
        queued: isQueuedSaleId(result.sale.id),
      }
      return sale
    },
    onSuccess: (sale) => {
      handled.current = false
      setReceiptProblem(null)
      setAskEmail(false)
      setSaleError(null)
      dispatchTill({ type: "completed", done: sale })
      settle()
    },
    onError: (error) => {
      if (error instanceof OverrideCancelled) {
        setSaleError("The sale is waiting for a manager. Ask again, or change the ticket.")
        return
      }
      setSaleError(refusalOrFallback(error, "That sale did not go through. Try again."))
    },
  })

  // When nothing is left to pay, the sale completes on its own, once for
  // each set of tenders. A refusal leaves "Try again" on the screen rather
  // than sending the same thing again by itself.
  const ready =
    phase === "paying" &&
    ticket.lines.length > 0 &&
    tenderState.left === 0 &&
    tenderState.over === 0 &&
    (tenders.length > 0 || totals.total === 0)
  const readyKey = ready ? JSON.stringify([totals.total, tenders]) : null
  const attempted = React.useRef<string | null>(null)
  const { mutate: complete, isPending: completing } = sell
  React.useEffect(() => {
    if (!readyKey || attempted.current === readyKey || completing) return
    attempted.current = readyKey
    complete()
  }, [readyKey, completing, complete])

  // ---- After the sale: the receipt ------------------------------------------

  const startNext = React.useCallback((notice: string | null) => {
    dispatchTill({ type: "newSale" })
    setReceiptProblem(null)
    setAskEmail(false)
    setScanNote(notice)
    setTicketNote(null)
    setSearch(null)
    setTab("items")
  }, [])

  async function chooseReceipt(choice: ReceiptChoice, email?: string) {
    if (!done) return
    setReceiptPending(choice)
    setReceiptProblem(null)
    const register = currentRegisterId()
    try {
      if (choice === "print" || choice === "gift") {
        // The receipt job carries the drawer kick for a cash sale, so the
        // drawer is only taken care of once the printer has the job.
        const outcome = await printReceipt({
          saleId: done.saleId,
          register,
          gift: choice === "gift",
          drawer: done.cash,
        })
        if (!outcome.ok) {
          setReceiptProblem(outcome.message)
          return
        }
        handled.current = true
        startNext(
          `${choice === "gift" ? "Gift receipt" : "Receipt"} for ${done.number} sent to the printer.`
        )
        return
      }
      if (choice === "email") {
        try {
          const sent = await emailReceipt(done.saleId, email)
          // An emailed receipt opens no drawer: leaving the done view does.
          startNext(`Receipt for ${done.number} sent to ${sent.sent_to}.`)
        } catch (error) {
          if (error instanceof ClientResponseError && error.status === 400) setAskEmail(true)
          setReceiptProblem(
            refusalMessage(error) ?? "That receipt could not be sent. Try again, or print it."
          )
        }
        return
      }
      // No receipt: the drawer still has to open for the cash. A drawer that
      // will not is said on the next ticket; the key in it still works.
      if (done.cash && !handled.current) {
        handled.current = true
        const outcome = await openDrawer(register)
        startNext(outcome.ok ? null : `The drawer did not open. ${outcome.message}`)
        return
      }
      startNext(null)
    } finally {
      setReceiptPending(null)
    }
  }

  /**
   * Leaving a cash sale without choosing a receipt (New sale, or simply
   * scanning the next customer's first item) is no receipt: the drawer
   * opens for the cash all the same. A drawer that will not is said on the
   * next ticket rather than holding this one.
   */
  const leftDone = React.useRef<DoneSale | null>(null)
  React.useEffect(() => {
    if (phase === "done" && done) {
      leftDone.current = done
      return
    }
    const left = leftDone.current
    leftDone.current = null
    if (!left?.cash || handled.current) return
    handled.current = true
    void openDrawer(currentRegisterId()).then((outcome) => {
      if (outcome.ok) return
      const drawer = `The drawer did not open. ${outcome.message}`
      // After whatever the receipt choice said, not instead of it.
      setScanNote((said) => (said ? `${said} ${drawer}` : drawer))
    })
  }, [phase, done])

  function newSale() {
    startNext(null)
  }

  // ---- Clearing, parking and recalling ------------------------------------

  const clear = useMutation({
    mutationFn: async () => {
      const state = getTill().ticket
      const lines = state.lines.map((line) => ({
        title: line.title,
        qty: line.qty,
        amount: lineNet(line),
      }))
      try {
        await voidTicketLines({ register: registerId || undefined, ticket: true, lines })
        await voidTicketLines({ register: registerId || undefined, ticket: false, lines: state.voided })
      } catch (error) {
        // Offline nothing can be logged, and a ticket nobody can clear is
        // worse than a void the X report does not count.
        if (!unanswered(error)) throw error
      }
    },
    onSuccess: () => {
      dispatchTill({ type: "clear" })
      setTicketNote(null)
      setScanNote("Ticket cleared")
    },
    onError: (error) => {
      setTicketNote(
        error instanceof OverrideCancelled
          ? "The ticket is still here. Clearing it needs a manager's approval."
          : refusalOrFallback(error, "The ticket could not be cleared. Try again.")
      )
    },
  })

  const park = useMutation({
    mutationFn: async (label: string) => {
      if (!registerId) throw new Error("The till's register is not known yet. Try again in a moment.")
      const state = getTill()
      const sums = summarise(state.ticket)
      await parkTicket({
        register: registerId,
        label,
        customer: state.ticket.customer?.id ?? null,
        payload: state.ticket,
        total: sums.total,
        itemIds: stockIds(state.ticket),
      })
      return label
    },
    onSuccess: (label) => {
      dispatchTill({ type: "newSale" })
      setParkOpen(false)
      setScanNote(`Parked as ${label}`)
      void queryClient.invalidateQueries({ queryKey: ["till-parked"] })
    },
  })

  const recall = useMutation({
    mutationFn: async (entry: ParkedTicket) => {
      const payload = entry.payload as Partial<Ticket> | null
      if (!payload || !Array.isArray(payload.lines)) {
        throw new Error("That ticket could not be read back. Ring it up again.")
      }
      try {
        await deleteParkedTicket(entry.id)
      } catch (error) {
        if (isNotFound(error)) {
          throw new Error("That ticket has already been recalled on the other till.", {
            cause: error,
          })
        }
        throw error
      }
      // The customer's balances as they are now, not as they were when the
      // ticket was parked: points and credit may have moved since.
      let customer = payload.customer ?? null
      if (customer?.code) {
        customer = (await getCustomerForSale(customer.code).catch(() => null)) ?? customer
      }
      return {
        entry,
        ticket: { ...getTill().ticket, ...payload, lines: payload.lines, customer } as Ticket,
      }
    },
    onSuccess: ({ entry, ticket: recalled }) => {
      dispatchTill({ type: "recall", ticket: recalled })
      setRecallOpen(false)
      setScanNote(`${entry.label} is back on the till`)
      setTab("ticket")
      void queryClient.invalidateQueries({ queryKey: ["till-parked"] })
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: ["till-parked"] }),
  })

  /** An item on this ticket that is also waiting on a parked one. */
  const clash = React.useMemo(() => {
    for (const line of ticket.lines) {
      if (!line.itemId) continue
      const other = parkedTickets.find((entry) => entry.itemIds.includes(line.itemId as string))
      if (other) return `${line.title} is also on the parked ticket ${other.label}.`
    }
    return null
  }, [ticket.lines, parkedTickets])

  // ---- The sheets ------------------------------------------------------------

  const line = lineKey ? (ticket.lines.find((entry) => entry.key === lineKey) ?? null) : null
  const firstName = ticket.customer?.name.trim().split(/\s+/)[0]
  const parkLabel = firstName || `Ticket ${parkedTickets.length + 1}`

  const sheets = (
    <>
      <CustomerSearchSheet
        open={customerOpen}
        onOpenChange={(open) => {
          setCustomerOpen(open)
          if (!open) setPendingProduct(null)
        }}
        onChoose={attachCustomer}
        description={
          pendingProduct
            ? `${pendingProduct.name} is sold to somebody. Search a name, a phone number or a card code.`
            : undefined
        }
      />
      <LineSheet
        line={line}
        limitPct={settings.discountLimitPct}
        onOpenChange={(open) => {
          if (!open) setLineKey(null)
        }}
        onSave={(target, patch) => {
          dispatchTill({ type: "updateLine", key: target.key, patch })
          setLineKey(null)
        }}
        onRemove={(target) => {
          dispatchTill({ type: "remove", key: target.key })
          setLineKey(null)
          setScanNote(`${target.title} taken off`)
        }}
      />
      <TicketDiscountSheet
        open={discountOpen}
        onOpenChange={setDiscountOpen}
        subtotal={totals.subtotal}
        discount={ticket.discount}
        limitPct={settings.discountLimitPct}
        onSave={(discount) => dispatchTill({ type: "setDiscount", discount })}
      />
      <KeyPriceSheet
        product={keyPrice}
        onOpenChange={(open) => {
          if (!open) setKeyPrice(null)
        }}
        onAdd={(product, price, detail) => {
          setKeyPrice(null)
          addProduct(product, price, detail)
        }}
      />
      <ParkSheet
        key={parkOpen ? `park-${parkLabel}` : "park"}
        open={parkOpen}
        onOpenChange={(open) => {
          setParkOpen(open)
          if (!open) park.reset()
        }}
        suggested={parkLabel}
        pending={park.isPending}
        error={park.error ? refusalOrFallback(park.error, "The ticket could not be parked. Try again.") : null}
        onPark={(label) => park.mutate(label)}
      />
      <RecallSheet
        open={recallOpen}
        onOpenChange={(open) => {
          setRecallOpen(open)
          if (!open) recall.reset()
        }}
        tickets={parkedTickets}
        loading={parked.isPending}
        blocked={phase !== "ticket" || ticket.lines.length > 0}
        pendingId={recall.isPending ? (recall.variables?.id ?? null) : null}
        error={recall.error ? refusalOrFallback(recall.error, "That ticket could not be recalled. Try again.") : null}
        onRecall={(entry) => recall.mutate(entry)}
      />
      <ReturnsSheet
        open={returns.open}
        number={returns.number}
        onOpenChange={(open) => setReturns((value) => ({ open, number: open ? value.number : "" }))}
      />
    </>
  )

  // ---- The panes --------------------------------------------------------------

  const readOnly = phase !== "ticket"
  const ticketPane = (docked: boolean) => (
    <TicketPane
      ticket={ticket}
      totals={totals}
      points={points}
      readOnly={readOnly}
      vatRegistered={settings.vatRegistered}
      pulsing={pulsing}
      clash={clash}
      docked={docked}
      notice={ticketNote}
      clearing={clear.isPending}
      onAddCustomer={() => setCustomerOpen(true)}
      onRemoveCustomer={() => dispatchTill({ type: "attachCustomer", customer: null })}
      onOpenLine={(target) => setLineKey(target.key)}
      onQty={(target, qty) => dispatchTill({ type: "setQty", key: target.key, qty })}
      onPark={() => setParkOpen(true)}
      onDiscount={() => setDiscountOpen(true)}
      onClear={() => clear.mutate()}
      onPay={() => {
        setScanNote(null)
        dispatchTill({ type: "pay" })
        setTab("items")
      }}
    />
  )

  const leftPane =
    phase === "done" && done ? (
      <DonePane
        key={done.saleId}
        done={done}
        pending={receiptPending}
        problem={receiptProblem}
        askEmail={askEmail}
        onChoose={(choice, email) => void chooseReceipt(choice, email)}
        onNewSale={newSale}
      />
    ) : phase === "paying" ? (
      <TenderPane
        total={totals.total}
        taken={tenders}
        state={tenderState}
        step={step}
        customer={ticket.customer}
        voucher={ticket.voucher}
        settings={settings}
        programme={setup?.programme}
        cashCap={config?.cashCap}
        completing={completing}
        error={saleError}
        onStep={(next) => dispatchTill({ type: "openStep", step: next })}
        onTenders={(next) => {
          setSaleError(null)
          dispatchTill({ type: "setTenders", tenders: next })
          dispatchTill({ type: "openStep", step: null })
        }}
        onRemoveTender={(id) => {
          setSaleError(null)
          dispatchTill({ type: "removeTender", id })
        }}
        onApplyVoucher={applyVoucher}
        onRemoveVoucher={() => dispatchTill({ type: "applyVoucher", voucher: null })}
        onAddCustomer={() => setCustomerOpen(true)}
        onBack={() => {
          setSaleError(null)
          dispatchTill({ type: "backToTicket" })
        }}
        onRetry={() => complete()}
      />
    ) : (
      <CataloguePane
        scanRef={scanRef}
        scanError={scanError}
        scanNote={scanNote}
        onScanTyping={(value) => {
          setScanError(null)
          setTyped(value)
        }}
        catalogue={catalogue.data}
        catalogueLoading={catalogue.isPending}
        catalogueError={catalogue.isError}
        onRetryCatalogue={() => void catalogue.refetch()}
        categoryId={categoryId}
        onCategory={(id) => {
          setSearch(null)
          setCategoryId(id)
        }}
        search={search}
        onClearSearch={() => {
          setSearch(null)
          setTyped("")
          if (scanRef.current) scanRef.current.value = ""
        }}
        onProduct={chooseProduct}
        onItem={chooseItem}
        onStock={(item) => void chooseStock(item)}
      />
    )

  const header = (
    <TillHeader
      registerName={registerName}
      openedSince={current.data?.session?.opened_at}
      closed={closed}
      parked={parkedTickets.length}
      onRecall={() => setRecallOpen(true)}
      onReturns={() => openReturns("")}
    />
  )

  if (closed) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="till">
        {header}
        <div className="flex flex-1 flex-col items-start justify-center gap-8 px-5 py-16 sm:px-10 min-[900px]:items-center">
          <p data-testid="till-closed" className="max-w-[44ch] text-[18px] leading-[1.45] text-foreground">
            The till is closed. Open it to start selling.
          </p>
          <Button
            size="till"
            trailingArrow
            render={<Link to="/counter/cash" search={{ action: "open" } as never} />}
          >
            Open the till
          </Button>
        </div>
        {sheets}
      </div>
    )
  }

  if (wide) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="till" data-phase={phase}>
        {header}
        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{leftPane}</div>
          <div className="flex min-h-0 w-[400px] shrink-0 flex-col border-l border-hairline-soft min-[1280px]:w-[440px]">
            {ticketPane(false)}
          </div>
        </div>
        {sheets}
      </div>
    )
  }

  // Below 900px: two tabs, the total and Pay docked under both.
  const count = ticket.lines.length
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="till" data-phase={phase}>
      {header}
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as "items" | "ticket")}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <TabsList className="flex w-full shrink-0 gap-0 px-3">
          <TabsTrigger value="items" className="min-h-14 flex-1 justify-center pt-5 pb-4">
            {phase === "paying" ? "Pay" : phase === "done" ? "Done" : "Items"}
          </TabsTrigger>
          <TabsTrigger value="ticket" className="min-h-14 flex-1 justify-center pt-5 pb-4" data-testid="till-ticket-tab">
            Ticket <span className="tnum">{count}</span>
          </TabsTrigger>
        </TabsList>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "items" ? leftPane : ticketPane(phase === "ticket")}
        </div>
      </Tabs>
      {phase === "ticket" && ticket.lines.length > 0 ? (
        <div className="flex shrink-0 items-center gap-4 border-t border-hairline-soft bg-background px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <span className="flex flex-col gap-1">
            <MicroLabel tone="ink">Total</MicroLabel>
            <span
              data-testid="till-dock-total"
              className="tnum font-display text-[32px] leading-none tracking-[0.01em] text-foreground"
            >
              {formatGBP(totals.total)}
            </span>
          </span>
          <Button
            size="till"
            data-testid="till-pay"
            className="min-w-0 flex-1"
            trailingArrow
            onClick={() => {
              setScanNote(null)
              dispatchTill({ type: "pay" })
              setTab("items")
            }}
          >
            Pay
          </Button>
        </div>
      ) : null}
      {sheets}
    </div>
  )
}
