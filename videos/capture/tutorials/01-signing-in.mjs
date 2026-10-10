/**
 * Tutorial 1: signing in and the till PIN. Signs in with an email and
 * password, tours the home screen and the person menu, sets a PIN of your own,
 * locks the till and unlocks it from the lock screen, hands the till to
 * another member of staff, and shows the on-the-spot manager approval.
 *
 * The demo only keeps its PINs and accounts in memory, so this script never
 * reloads the page once it has signed in: every move is a click.
 */
import { DEMO_EMAIL, DEMO_PASSWORD, session } from "../lib.mjs"

// Demo-only PINs. Yours is set in the script; Sam's and Mo's come with the demo.
const MY_PIN = "7391"
const SAM_PIN = "482916" // Sam Bell, a member of staff, six digits
const MO_PIN = "1357" // Mo Khan, the manager

export default async function capture({ baseURL }) {
  const t = await session(
    {
      slug: "signing-in",
      number: 1,
      title: "Signing in and the till PIN",
      subtitle: "Sign in, set your own PIN, lock the till and hand it over safely.",
      outline: [
        "Sign in with your email and password",
        "Find your way around the home screen",
        "Set your own PIN",
        "Lock the till and unlock it with your PIN",
        "Switch user, and ask a manager to approve",
      ],
      next: "Adding stock",
    },
    { baseURL }
  )
  const { page, step, show } = t

  // The demo's own labels are for testing, not for staff: the "Demo data"
  // line on the sign-in screen, the "Demo account" note under the form, and
  // the "Simulate offline" item in the person menu. A real till has none of
  // them, so they are hidden before anything is drawn.
  await page.addInitScript(() => {
    const hide = () => {
      for (const el of document.querySelectorAll("span, p, div, [role='menuitem']")) {
        const text = (el.textContent || "").trim()
        if (el.getAttribute("role") === "menuitem" && text.startsWith("Simulate offline")) {
          el.style.display = "none"
        } else if (el.children.length === 0 && text === "Demo data") {
          el.style.display = "none"
        } else if (el.children.length === 0 && text === "Demo account" && el.parentElement) {
          el.parentElement.style.display = "none"
        }
      }
    }
    new MutationObserver(hide).observe(document, { childList: true, subtree: true })
  })

  // The demo pre-fills the sign-in form. Staff start from empty boxes, so the
  // video does too, and the typing is seen.
  await page.goto("/login?demo=1")
  await page.getByLabel("Email").waitFor()
  await page.getByLabel("Email").fill("")
  await page.getByLabel("Password", { exact: true }).fill("")

  // --- Places on the screen ---------------------------------------------------
  const avatar = () => page.getByRole("button", { name: /Account menu/ })
  const menu = () => page.getByRole("menu")
  const lockScreen = () => page.getByRole("dialog", { name: "Locked" })
  const today = () => page.getByRole("heading", { name: "Today" })
  /** Moves the real mouse into an empty corner, so no key or link is left looking hovered. */
  const park = () => page.mouse.move(1400, 880)
  const pad = (name) => lockScreen().getByRole("group", { name: `PIN for ${name}` })

  /** Presses the keys of a PIN one by one on a keypad, as a finger would. */
  const pressKeys = (digits) => async (keypad) => {
    for (const digit of digits) {
      await keypad.getByRole("button", { name: digit, exact: true }).click()
    }
    await park()
  }

  const openMenu = (caption, opts = {}) =>
    step(caption, avatar(), { zoom: true, then: () => menu().waitFor(), ...opts })

  const lockFromMenu = (caption) =>
    step(caption, page.getByRole("menuitem", { name: "Lock", exact: true }), {
      zoom: true,
      then: () => lockScreen().getByRole("heading", { name: "Locked" }).waitFor(),
    })

  // --- Sign in -----------------------------------------------------------------
  await step("Start at the sign-in screen. Type your work email address.", page.getByLabel("Email"), {
    section: "Sign in",
    action: "type",
    value: DEMO_EMAIL,
    zoom: true,
  })
  await step("Now type your password. It shows as dots, so nobody can read it over your shoulder.", page.getByLabel("Password", { exact: true }), {
    action: "type",
    value: DEMO_PASSWORD,
    zoom: true,
  })
  await step("Press Sign in.", page.getByRole("button", { name: "Sign in" }), {
    zoom: true,
    then: () => today().waitFor(),
  })

  // --- The home screen ---------------------------------------------------------
  await show("This is Home. The four figures count the day as it goes: Sales, Buy-ins, Cash out and Credit issued.", page.getByTestId("today-tiles"), {
    section: "The home screen",
    zoom: true,
    settle: 900,
  })
  await show(
    "The top bar takes you around: Till, Bookings, Stock, Trade, Customers and Reports. The logo on the left always brings you back to Home.",
    page.getByRole("banner"),
    { zoom: true }
  )
  await show(
    "The quick actions are shortcuts to the jobs you do most: Till, Scan, Buy-in, Add stock and Cash up.",
    page.getByText("Quick actions", { exact: true }).locator("xpath=.."),
    { zoom: true }
  )
  await openMenu("Your initials at the top right open the person menu. Click them.")
  await show(
    "The person menu has your own settings, with Lock and Sign out at the bottom. You may see more or fewer items, depending on your role.",
    menu(),
    { zoom: true }
  )

  // --- Set your PIN ------------------------------------------------------------
  const pinSheet = () => page.getByRole("dialog", { name: "Set your PIN" })
  const stepUp = () => page.getByRole("dialog", { name: "Confirm your password to continue" })

  await step("Choose Set PIN. A PIN is a short number that unlocks the till as you.", page.getByRole("menuitem", { name: "Set PIN" }), {
    section: "Set your PIN",
    zoom: true,
    then: () => pinSheet().getByLabel("New PIN", { exact: true }).waitFor(),
  })
  await step(
    "Type a PIN of 4 or 6 digits that only you know. Avoid runs and repeats such as 1234 or 0000.",
    pinSheet().getByLabel("New PIN", { exact: true }),
    { action: "type", value: MY_PIN, zoom: true }
  )
  await step("Type the same PIN again, to be sure.", pinSheet().getByLabel("New PIN again"), {
    action: "type",
    value: MY_PIN,
    zoom: true,
  })
  await step("Press Save PIN.", pinSheet().getByRole("button", { name: "Save PIN" }), {
    zoom: true,
    then: () => stepUp().waitFor(),
  })
  await step("The till asks for your password once, to check it is really you. Type it.", stepUp().getByLabel("Password"), {
    action: "type",
    value: DEMO_PASSWORD,
    zoom: true,
  })
  await step("Press Continue.", stepUp().getByRole("button", { name: "Continue" }), {
    zoom: true,
    then: () => pinSheet().getByTestId("pin-saved").waitFor(),
  })
  await step("Your PIN is set and works at the lock screen on any till. Press Done.", pinSheet().getByRole("button", { name: "Done" }), {
    zoom: true,
    then: () => pinSheet().waitFor({ state: "hidden" }),
  })

  // --- Lock the till -------------------------------------------------------------
  await openMenu("To step away from the till, lock it. Open the person menu.", { section: "Lock the till" })
  await lockFromMenu("Choose Lock.")
  await show(
    "The till is locked. Everyone who works on it has a name here, and a name marked No PIN has not set one yet.",
    lockScreen().getByRole("list", { name: "Staff on this till" }),
    { zoom: true }
  )
  await step("Tap your own name.", lockScreen().getByRole("button", { name: "Demo Counter", exact: true }), {
    zoom: true,
    then: () => lockScreen().getByTestId("pin-name").waitFor(),
  })
  await step("Here is what a slip looks like. Press a wrong PIN on purpose: 1, 1, 1, 1.", pad("Demo Counter"), {
    action: pressKeys("1111"),
    zoom: true,
    then: () => lockScreen().getByTestId("pin-error").filter({ hasText: "tries left" }).waitFor(),
  })
  await show(
    "A wrong PIN clears the dots and says how many tries are left. After five wrong tries the PIN locks, so sign in with your password or ask an admin to reset it.",
    lockScreen().getByTestId("pin-error"),
    { zoom: true }
  )
  await step("Now your own PIN: 7, 3, 9, 1. The last digit unlocks the till, so there is no Enter key.", pad("Demo Counter"), {
    action: pressKeys(MY_PIN),
    zoom: true,
    then: async () => {
      await lockScreen().waitFor({ state: "hidden" })
      await today().waitFor()
    },
  })

  // --- Switch user ------------------------------------------------------------------
  await openMenu("Someone else is taking over the till. Lock it again from the person menu.", { section: "Switch user" })
  await lockFromMenu("Choose Lock.")
  await step("Sam is next. Tap Sam's name.", lockScreen().getByRole("button", { name: "Sam Bell", exact: true }), {
    zoom: true,
    then: () => lockScreen().getByRole("img", { name: "0 of 6 digits entered" }).waitFor(),
  })
  await step("Sam's PIN has six digits, so there are six dots. Press it: 4, 8, 2, 9, 1, 6.", pad("Sam Bell"), {
    action: pressKeys(SAM_PIN),
    zoom: true,
    then: async () => {
      await lockScreen().waitFor({ state: "hidden" })
      await page.getByRole("button", { name: "Account menu for Sam Bell" }).waitFor()
      await today().waitFor()
    },
  })
  await show(
    "Sam is in, and the screen is just as it was. Sam's initials are at the top right, and nobody was signed out.",
    page.getByRole("button", { name: "Account menu for Sam Bell" }),
    { zoom: true }
  )

  // --- Manager approval ------------------------------------------------------------------
  const noSale = () => page.getByRole("dialog", { name: "No sale" })
  const approval = () => page.getByTestId("override-dialog")

  await step(
    "Some jobs need a manager. Here Sam wants to open the drawer with no sale, so open Cash up.",
    page.getByRole("link", { name: "Cash up" }).last(),
    {
      section: "Manager approval",
      zoom: true,
      then: () => page.getByRole("heading", { level: 1, name: "Cash up" }).waitFor(),
    }
  )
  await step("Press No sale.", page.getByRole("button", { name: "No sale", exact: true }), {
    zoom: true,
    then: () => noSale().getByLabel("Why").waitFor(),
  })
  await step("Type the reason. Every no sale is listed on the X and the Z with its reason.", noSale().getByLabel("Why"), {
    action: "type",
    value: "Change for a customer",
    zoom: true,
  })
  await step("Press Open the drawer.", noSale().getByRole("button", { name: "Open the drawer" }), {
    zoom: true,
    then: () => approval().waitFor(),
  })
  await show(
    "A manager has to approve this, and the screen says exactly what it is. If nobody will, press Cancel and nothing changes.",
    approval(),
    { zoom: true, hold: 7 }
  )
  await step("The manager taps their own name. You cannot approve your own request, so Sam is not on the list.", approval().getByRole("button", { name: "Mo Khan", exact: true }), {
    zoom: true,
    then: async () => {
      await park()
      await approval().getByTestId("pin-name").waitFor()
    },
  })
  await step("The manager presses their own PIN, not Sam's. The last digit approves it.", approval().getByRole("group", { name: "PIN for Mo Khan" }), {
    action: pressKeys(MO_PIN),
    zoom: true,
    then: async () => {
      await approval().waitFor({ state: "hidden" })
      await page.getByTestId("cash-notice").waitFor()
    },
  })
  await show("Approved. The no sale is recorded with its reason, and the drawer opens.", page.getByTestId("cash-notice"), {
    zoom: true,
    hold: 5,
  })

  await t.finish()
}
