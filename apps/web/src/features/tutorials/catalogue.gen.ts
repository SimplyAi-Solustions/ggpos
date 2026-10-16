// Written by videos/publish-to-app.mjs from the rendered tutorials. Do not edit by hand:
// change the capture script in videos/capture/tutorials, render, and publish again.
import type { Tutorial } from "./types"

export const TUTORIALS: Tutorial[] = [
  {
    slug: "signing-in",
    number: 1,
    title: "Signing in and the till PIN",
    subtitle: "Sign in, set your own PIN, lock the till and hand it over safely.",
    video: "/tutorials/01-signing-in.mp4?v=ac9d80bf9651",
    poster: "/tutorials/01-signing-in.jpg?v=ac9d80bf9651",
    duration: 260.67,
    chapters: [
      {
        title: "Sign in",
        start: 11.1,
        steps: [
          {
            caption: "Start at the sign-in screen. Type your work email address.",
            start: 13.3,
          },
          {
            caption: "Now type your password. It shows as dots, so nobody can read it over your shoulder.",
            start: 20.87,
          },
          {
            caption: "Press Sign in.",
            start: 29.4,
          },
        ],
      },
      {
        title: "The home screen",
        start: 32.8,
        steps: [
          {
            caption: "This is Home. The four figures count the day as it goes: Sales, Buy-ins, Cash out and Credit issued.",
            start: 35,
          },
          {
            caption: "The top bar takes you around: Till, Bookings, Stock, Trade, Customers and Reports. The logo on the left always brings you back to Home.",
            start: 42.6,
          },
          {
            caption: "The quick actions are shortcuts to the jobs you do most: Till, Scan, Buy-in, Add stock and Cash up.",
            start: 51.6,
          },
          {
            caption: "Your initials at the top right open the person menu. Click them.",
            start: 59.2,
          },
          {
            caption: "The person menu has your own settings, with Lock and Sign out at the bottom. You may see more or fewer items, depending on your role.",
            start: 65.2,
          },
        ],
      },
      {
        title: "Set your PIN",
        start: 74.2,
        steps: [
          {
            caption: "Choose Set PIN. A PIN is a short number that unlocks the till as you.",
            start: 76.4,
          },
          {
            caption: "Type a PIN of 4 or 6 digits that only you know. Avoid runs and repeats such as 1234 or 0000.",
            start: 83.3,
          },
          {
            caption: "Type the same PIN again, to be sure.",
            start: 92.3,
          },
          {
            caption: "Press Save PIN.",
            start: 97.93,
          },
          {
            caption: "The till asks for your password once, to check it is really you. Type it.",
            start: 101.33,
          },
          {
            caption: "Press Continue.",
            start: 109.57,
          },
          {
            caption: "Your PIN is set and works at the lock screen on any till. Press Done.",
            start: 112.97,
          },
        ],
      },
      {
        title: "Lock the till",
        start: 119.87,
        steps: [
          {
            caption: "To step away from the till, lock it. Open the person menu.",
            start: 122.07,
          },
          {
            caption: "Choose Lock.",
            start: 128.07,
          },
          {
            caption: "The till is locked. Everyone who works on it has a name here, and a name marked No PIN has not set one yet.",
            start: 131.47,
          },
          {
            caption: "Tap your own name.",
            start: 140.47,
          },
          {
            caption: "Here is what a slip looks like. Press a wrong PIN on purpose: 1, 1, 1, 1.",
            start: 144.07,
          },
          {
            caption: "A wrong PIN clears the dots and says how many tries are left. After five wrong tries the PIN locks, so sign in with your password or ask an admin to reset it.",
            start: 151.57,
          },
          {
            caption: "Now your own PIN: 7, 3, 9, 1. The last digit unlocks the till, so there is no Enter key.",
            start: 160.57,
          },
        ],
      },
      {
        title: "Switch user",
        start: 168.97,
        steps: [
          {
            caption: "Someone else is taking over the till. Lock it again from the person menu.",
            start: 171.17,
          },
          {
            caption: "Choose Lock.",
            start: 177.77,
          },
          {
            caption: "Sam is next. Tap Sam's name.",
            start: 181.17,
          },
          {
            caption: "Sam's PIN has six digits, so there are six dots. Press it: 4, 8, 2, 9, 1, 6.",
            start: 185.37,
          },
          {
            caption: "Sam is in, and the screen is just as it was. Sam's initials are at the top right, and nobody was signed out.",
            start: 193.17,
          },
        ],
      },
      {
        title: "Manager approval",
        start: 201.97,
        steps: [
          {
            caption: "Some jobs need a manager. Here Sam wants to open the drawer with no sale, so open Cash up.",
            start: 204.17,
          },
          {
            caption: "Press No sale.",
            start: 212.27,
          },
          {
            caption: "Type the reason. Every no sale is listed on the X and the Z with its reason.",
            start: 215.67,
          },
          {
            caption: "Press Open the drawer.",
            start: 224.67,
          },
          {
            caption: "A manager has to approve this, and the screen says exactly what it is. If nobody will, press Cancel and nothing changes.",
            start: 228.27,
          },
          {
            caption: "The manager taps their own name. You cannot approve your own request, so Sam is not on the list.",
            start: 235.27,
          },
          {
            caption: "The manager presses their own PIN, not Sam's. The last digit approves it.",
            start: 243.37,
          },
          {
            caption: "Approved. The no sale is recorded with its reason, and the drawer opens.",
            start: 249.67,
          },
        ],
      },
    ],
  },
  {
    slug: "adding-stock",
    number: 2,
    title: "Adding stock",
    subtitle: "Put a card or a box on the shelf, price it, label it, photograph it and find it again.",
    video: "/tutorials/02-adding-stock.mp4?v=93d92f8dd6e1",
    poster: "/tutorials/02-adding-stock.jpg?v=93d92f8dd6e1",
    duration: 362.57,
    chapters: [
      {
        title: "Open Add stock",
        start: 11.1,
        steps: [
          {
            caption: "Add stock is on the home screen. Press it whenever something new is going on the shelf.",
            start: 13.3,
          },
          {
            caption: "One page holds everything about the item. You fill it in, then save it once at the bottom.",
            start: 20.8,
          },
        ],
      },
      {
        title: "Add a single",
        start: 25.3,
        steps: [
          {
            caption: "Choose the game, here Pokemon. The search is quicker when it knows which game to look in.",
            start: 27.5,
          },
          {
            caption: "Type the set and the card number. A card's name works too.",
            start: 35,
          },
          {
            caption: "Choose the card from the list.",
            start: 42.13,
          },
          {
            caption: "The card's picture, name and set appear here. Check it is the right printing.",
            start: 46.33,
          },
          {
            caption: "Choose the finish. This printing is Holo.",
            start: 52.43,
          },
          {
            caption: "Choose the condition. NM is near mint. The price below is worked out for the condition you pick.",
            start: 56.93,
          },
          {
            caption: "Type what the card cost you. Cost is needed so the reports can work out your margin.",
            start: 64.73,
          },
        ],
      },
      {
        title: "Price it",
        start: 73,
        steps: [
          {
            caption: "The Price box is already filled in with the suggested price, which is shown under its label.",
            start: 75.2,
          },
          {
            caption: "Market shows what each price source says this card is worth, in pounds.",
            start: 82.2,
          },
          {
            caption: "Suggested is the price worked out from the market value. It fills the Price box until you type your own, and Use suggested puts it back.",
            start: 87.2,
          },
        ],
      },
      {
        title: "File it in the tree",
        start: 93.2,
        steps: [
          {
            caption: "Now say where it lives in the category tree. Press Choose a branch.",
            start: 95.4,
          },
          {
            caption: "Go down the tree one level at a time. Start with Trading cards.",
            start: 101.7,
          },
          {
            caption: "Then Pokémon.",
            start: 108,
          },
          {
            caption: "Then Singles.",
            start: 111.4,
          },
          {
            caption: "The path along the bottom says where the card will be filed. Press Choose this branch.",
            start: 114.8,
          },
          {
            caption: "The branch is filled in, and the kind, game and VAT follow it. You can still change any of them.",
            start: 122,
          },
        ],
      },
      {
        title: "Save and print the label",
        start: 127,
        steps: [
          {
            caption: "Check the details, then press Save item.",
            start: 129.2,
          },
          {
            caption: "Saved. The card has its own code. It is the one on the label.",
            start: 133.7,
          },
          {
            caption: "Press Print label.",
            start: 139.8,
          },
          {
            caption: "The label is in the queue for the label printer.",
            start: 143.2,
          },
        ],
      },
      {
        title: "Add sealed product",
        start: 148.1,
        steps: [
          {
            caption: "Now a pack of sealed product, added from its barcode. Press the GG Vault logo to go back to the home screen.",
            start: 150.3,
          },
          {
            caption: "Press Scan.",
            start: 159.3,
          },
          {
            caption: "Scan the barcode on the pack with the scanner. Typing the number and pressing Enter does the same.",
            start: 162.7,
          },
          {
            caption: "Add stock opens. Say what the product is by pressing Choose a branch.",
            start: 171.7,
          },
          {
            caption: "Quicker than going down the tree: search every branch. Type booster.",
            start: 178,
          },
          {
            caption: "Choose the first result: Trading cards, Pokémon, Sealed, Booster packs.",
            start: 184.73,
          },
          {
            caption: "Press Choose this branch.",
            start: 190.13,
          },
          {
            caption: "The branch has filled in the kind, the game and the VAT. There is no card to search for, so Title takes its place.",
            start: 193.73,
          },
          {
            caption: "Type a title, so it can be found on the shelf.",
            start: 198.73,
          },
          {
            caption: "Type how many you have. Sealed product is one line with a quantity, not one row each.",
            start: 207,
          },
          {
            caption: "Type the cost of one pack.",
            start: 215.17,
          },
          {
            caption: "Type the price of one pack. Sealed product has no market figure, so you set this yourself.",
            start: 220.2,
          },
          {
            caption: "The barcode you scanned is already in the EAN box.",
            start: 228.53,
          },
          {
            caption: "Press Save item.",
            start: 233.43,
          },
        ],
      },
      {
        title: "Take a photo",
        start: 236.83,
        steps: [
          {
            caption: "The packs are saved as one line, with one code. Now a photo of the card: go back to the home screen with the logo.",
            start: 239.03,
          },
          {
            caption: "Press Scan.",
            start: 248.03,
          },
          {
            caption: "Scan the label you printed. It opens the item. Typing the code works too.",
            start: 251.43,
          },
          {
            caption: "Under Photos, press Take photo. The same button is on the Saved screen after you add something.",
            start: 259.23,
          },
          {
            caption: "The camera shows a frame. Lay the card flat on a plain background and fill the frame with it.",
            start: 266.73,
          },
          {
            caption: "Press Take photo.",
            start: 271.73,
          },
          {
            caption: "This is the photo, cropped to the frame. If it is not right, press Take it again.",
            start: 275.13,
          },
          {
            caption: "Press Save photo.",
            start: 280.13,
          },
          {
            caption: "The photo is on the item. The first photo is the one the website shows.",
            start: 283.53,
          },
        ],
      },
      {
        title: "The item page",
        start: 289.93,
        steps: [
          {
            caption: "The price is at the top of the item page. Edit changes it.",
            start: 292.13,
          },
          {
            caption: "Branch says where it is filed in the tree. Change moves it somewhere else.",
            start: 297.93,
          },
          {
            caption: "The Website switch decides whether the item is listed on the shop's website. Switch it on.",
            start: 304.03,
          },
          {
            caption: "It now says Shown online, and the line underneath says it is on the website. Switch it off again to take it down.",
            start: 311.23,
          },
        ],
      },
      {
        title: "Find it again",
        start: 316.23,
        steps: [
          {
            caption: "To find stock again, open Stock.",
            start: 318.43,
          },
          {
            caption: "Narrow the list by branch. Press Choose a branch.",
            start: 322.63,
          },
          {
            caption: "Start with Trading cards.",
            start: 327.73,
          },
          {
            caption: "Then Pokémon.",
            start: 331.33,
          },
          {
            caption: "Press Choose this branch. The list shows everything in Pokémon, and every branch beneath it.",
            start: 334.73,
          },
          {
            caption: "Narrow it further in the search box. It takes a title, a code, a set or a barcode.",
            start: 341.63,
          },
          {
            caption: "Both Charizards are listed, each with its code, category, condition, price and status. Press a row to open the item.",
            start: 350.57,
          },
        ],
      },
    ],
  },
  {
    slug: "selling",
    number: 3,
    title: "Selling at the till",
    subtitle: "Scan, change a line, take payment, receipts, parking and returns.",
    video: "/tutorials/03-selling.mp4?v=217bd6ef293d",
    poster: "/tutorials/03-selling.jpg?v=217bd6ef293d",
    duration: 269,
    chapters: [
      {
        title: "Open the till",
        start: 11.1,
        steps: [
          {
            caption: "Every shift starts on the home screen. Open the till from the top bar.",
            start: 13.3,
          },
          {
            caption: "The till: the shop's products and categories on the left, the ticket on the right.",
            start: 19.9,
          },
        ],
      },
      {
        title: "Put items on the ticket",
        start: 24.9,
        steps: [
          {
            caption: "Scan the label with the scanner. Typing the code and pressing Enter does the same.",
            start: 27.1,
          },
          {
            caption: "No label? Tap a tile instead. Here, an hour of table time.",
            start: 35.2,
          },
          {
            caption: "Both lines are on the ticket, with the running total underneath.",
            start: 41.2,
          },
        ],
      },
      {
        title: "Attach a Guild member",
        start: 46.4,
        steps: [
          {
            caption: "Scan the customer's Guild card to attach them. Their points are worked out as you go.",
            start: 48.6,
          },
          {
            caption: "Jasmine is attached. Her tier and the points this sale earns show on the ticket.",
            start: 57,
          },
        ],
      },
      {
        title: "Change a line",
        start: 63.4,
        steps: [
          {
            caption: "Tap a line to change it. The Charizard has a dinged corner, so it gets a discount.",
            start: 65.6,
          },
          {
            caption: "Choose Percent for a percentage off, or Amount for money off.",
            start: 73.1,
          },
          {
            caption: "Type the percentage.",
            start: 78.8,
          },
          {
            caption: "Add a note to say why. It prints on the receipt and stays on the sale.",
            start: 82.83,
          },
          {
            caption: "Save the change.",
            start: 91.3,
          },
          {
            caption: "The line shows the discount, the note and the new price.",
            start: 94.7,
          },
        ],
      },
      {
        title: "Take payment",
        start: 99.9,
        steps: [
          {
            caption: "When the customer is ready, press Pay.",
            start: 102.1,
          },
          {
            caption: "The amount to pay is at the top. Payments can be split across as many ways as needed.",
            start: 106.6,
          },
          {
            caption: "This customer pays £50.00 in cash first. Choose Cash.",
            start: 113.9,
          },
          {
            caption: "Key the amount handed over on the money pad, or with the keyboard: 5, 0, 0, 0 for £50.00.",
            start: 119,
          },
          {
            caption: "Take the cash. The rest stays to pay.",
            start: 127.1,
          },
          {
            caption: "£50.00 in cash is taken. The rest goes on the card.",
            start: 131.9,
          },
          {
            caption: "Choose Card. The till tells you the amount to key on the Tide reader.",
            start: 137.1,
          },
          {
            caption: "Key exactly this amount on the Tide card reader and let the customer tap or insert their card.",
            start: 143.7,
          },
          {
            caption: "When the reader says approved, press Approved.",
            start: 149.2,
          },
          {
            caption: "Type the last four digits of the card from the reader's slip, for matching up at the end of the day.",
            start: 153.7,
          },
          {
            caption: "Press Approved again to finish.",
            start: 162.7,
          },
        ],
      },
      {
        title: "Receipts",
        start: 166.6,
        steps: [
          {
            caption: "Paid. The sale has its number, and the stock and the customer's points are updated.",
            start: 168.8,
          },
          {
            caption: "Print a receipt, email it, or choose No receipt. Any of them starts the next sale.",
            start: 173.8,
          },
          {
            caption: "This customer doesn't want one.",
            start: 180.5,
          },
        ],
      },
      {
        title: "Park a ticket",
        start: 184.4,
        steps: [
          {
            caption: "Someone wants to keep browsing? Put their item on a ticket and park it.",
            start: 186.6,
          },
          {
            caption: "Press Park.",
            start: 194.4,
          },
          {
            caption: "Give it a name you will recognise.",
            start: 197.8,
          },
          {
            caption: "Park it. The till is clear for the next customer.",
            start: 203.57,
          },
          {
            caption: "Parked tickets wait here. Tap to bring one back when they're ready to pay.",
            start: 208.97,
          },
          {
            caption: "Choose the ticket. It comes back exactly as it was.",
            start: 215.57,
          },
          {
            caption: "Clear the ticket to start again.",
            start: 220.97,
          },
          {
            caption: "Confirm.",
            start: 225.17,
          },
        ],
      },
      {
        title: "Take a return",
        start: 228.57,
        steps: [
          {
            caption: "For a return, scan the barcode on the receipt.",
            start: 230.77,
          },
          {
            caption: "The sale opens with what was bought. Tick what is coming back.",
            start: 237,
          },
          {
            caption: "Say why it is coming back.",
            start: 242.5,
          },
          {
            caption: "The money goes back the way it was paid, here cash. You can choose another way.",
            start: 247.9,
          },
          {
            caption: "Refund it.",
            start: 254.6,
          },
          {
            caption: "Done: the refund has its own number, the card is back in stock and the drawer is updated.",
            start: 258,
          },
        ],
      },
    ],
  },
  {
    slug: "trade-ins",
    number: 4,
    title: "Trade-ins with the ID check",
    subtitle: "Buy items from a customer, do the ID check for cash, and take a trade-in at the till.",
    video: "/tutorials/04-trade-ins.mp4?v=875dc99c7bd4",
    poster: "/tutorials/04-trade-ins.jpg?v=875dc99c7bd4",
    duration: 360.57,
    chapters: [
      {
        title: "Start a buy-in",
        start: 11.1,
        steps: [
          {
            caption: "Buy-ins start on the Trade screen. Choose Trade in the top bar.",
            start: 13.3,
          },
          {
            caption: "Every buy-in is listed here, newest first. When someone brings items in to sell, press New buy-in.",
            start: 19.3,
          },
        ],
      },
      {
        title: "The customer",
        start: 26.8,
        steps: [
          {
            caption: "Find the customer first. Type their name, phone number or GGC code, or scan their Guild card.",
            start: 29,
          },
          {
            caption: "Anyone who matches is listed underneath. Choose a name to use their card.",
            start: 37.27,
          },
          {
            caption: "If the customer is not listed, they have no card yet. Press New customer to make one.",
            start: 43.07,
          },
          {
            caption: "The name you searched for is filled in. Type their full name instead.",
            start: 50.57,
          },
          {
            caption: "Phone and email are optional, so a name is enough. Press Save and carry on.",
            start: 58.2,
          },
          {
            caption: "The new card is made and chosen. Their ID shows as Not on file, so a cash buy-in will need the full ID check.",
            start: 65.1,
          },
          {
            caption: "Press Add items.",
            start: 74.1,
          },
        ],
      },
      {
        title: "The items",
        start: 77.5,
        steps: [
          {
            caption: "Say what kind of item it is: Card, Graded, Retro, Sealed or Bulk lot. Start with a card.",
            start: 79.7,
          },
          {
            caption: "Type the set and card number, here sv151 199. The card's name works too.",
            start: 87,
          },
          {
            caption: "Choose the card from the list.",
            start: 94.73,
          },
          {
            caption: "The card is on the buy-in with its market value, and the cash and store credit offers beside it.",
            start: 98.93,
          },
          {
            caption: "Set its condition, from NM down to DMG. This one is Lightly Played, so choose LP.",
            start: 103.93,
          },
          {
            caption: "The cash and store credit offers have dropped for the lower condition.",
            start: 111.13,
          },
          {
            caption: "Now a sealed box. Choose Sealed.",
            start: 116.63,
          },
          {
            caption: "Type what it is.",
            start: 120.83,
          },
          {
            caption: "Press Add line.",
            start: 126.97,
          },
          {
            caption: "A sealed box has no price lookup, so type its market value yourself.",
            start: 130.37,
          },
          {
            caption: "The bar at the bottom adds it all up: market value, the cash offer and the store credit offer.",
            start: 137.4,
          },
          {
            caption: "Press Make the offer.",
            start: 145,
          },
        ],
      },
      {
        title: "The offer",
        start: 148.6,
        steps: [
          {
            caption: "Show the customer both offers. Cash needs photo ID. Store credit does not.",
            start: 150.8,
          },
          {
            caption: "This customer wants cash. Choose Cash.",
            start: 156.6,
          },
          {
            caption: "Choosing cash has added an ID check to the steps along the top.",
            start: 160.8,
          },
          {
            caption: "Read the terms to the customer. Tick the box once they have heard them and agree.",
            start: 166.6,
          },
          {
            caption: "The customer signs on the screen with a finger or a stylus.",
            start: 173.8,
          },
          {
            caption: "Once they have signed, press Check ID.",
            start: 179.8,
          },
        ],
      },
      {
        title: "Check their ID",
        start: 184.3,
        steps: [
          {
            caption: "Cash needs an ID check. The notice says why the shop photographs the ID and how long it is kept. Read it to the customer.",
            start: 186.5,
          },
          {
            caption: "Take a photo of the customer's original ID with Choose file. It is resized when saved, so no location data is kept.",
            start: 192.5,
          },
          {
            caption: "Choose the type of ID: Passport, Driving licence or Other. Here it is a driving licence.",
            start: 201.5,
          },
          {
            caption: "Enter the expiry date printed on the ID.",
            start: 208.7,
          },
          {
            caption: "Type the last four digits of the ID number.",
            start: 213.5,
          },
          {
            caption: "Enter their date of birth. Cash is only paid to customers aged 18 or over.",
            start: 219.43,
          },
          {
            caption: "Type their address. The buy-in register needs it as well as the ID.",
            start: 226.33,
          },
          {
            caption: "Tick to confirm you have seen the original ID and it matches the person in front of you.",
            start: 235.03,
          },
          {
            caption: "Everything is in. Press Complete buy-in.",
            start: 242.83,
          },
        ],
      },
      {
        title: "Finish the buy-in",
        start: 247.03,
        steps: [
          {
            caption: "Bought in. Hand the customer the amount under Cash out.",
            start: 249.23,
          },
          {
            caption: "Both items are now in stock, each with its own code.",
            start: 254.13,
          },
          {
            caption: "A label for each is queued for the counter printer.",
            start: 259.33,
          },
          {
            caption: "Press Receipt for the customer's paperwork.",
            start: 264.23,
          },
          {
            caption: "The receipt records who sold the items: their name and address, and the ID they showed. Print it for the customer.",
            start: 268.43,
          },
        ],
      },
      {
        title: "Part-exchange",
        start: 273.43,
        steps: [
          {
            caption: "A customer can also put what they are selling towards what they are buying. Open the till.",
            start: 275.63,
          },
          {
            caption: "Scan their Guild card first. A trade-in needs the customer on the ticket.",
            start: 283.13,
          },
          {
            caption: "Scan what they are buying.",
            start: 290.63,
          },
          {
            caption: "Press Trade in, under the ticket.",
            start: 295.73,
          },
          {
            caption: "Add what they are selling the same way as in a buy-in. Here a card: type sv151 205.",
            start: 299.93,
          },
          {
            caption: "Choose the card.",
            start: 308.87,
          },
          {
            caption: "At the till a trade-in is valued at credit rates, because its value comes off the bill. The cash offer shows underneath.",
            start: 312.27,
          },
          {
            caption: "On the ticket the trade-in has its own group, and its value comes off the total.",
            start: 317.27,
          },
          {
            caption: "Press Pay.",
            start: 323.97,
          },
          {
            caption: "The trade-in pays part of the bill. Read the terms to the customer, then tick the box.",
            start: 327.37,
          },
          {
            caption: "The customer signs here too.",
            start: 334.87,
          },
          {
            caption: "The customer pays the rest as in any sale. Choose Cash.",
            start: 338.77,
          },
          {
            caption: "Press Exact if they hand over the right money.",
            start: 344.47,
          },
          {
            caption: "Paid. The sale has its number, and the trade-in has its own buy-in number.",
            start: 349.57,
          },
        ],
      },
    ],
  },
  {
    slug: "market-values",
    number: 5,
    title: "Getting market values",
    subtitle: "How to find out what a card or a retro game is worth, and what the shop would offer for it.",
    video: "/tutorials/05-market-values.mp4?v=da5b5beef769",
    poster: "/tutorials/05-market-values.jpg?v=da5b5beef769",
    duration: 323.3,
    chapters: [
      {
        title: "Price check",
        start: 11.1,
        steps: [
          {
            caption: "A customer asks what a card is worth. From the home screen, open Scan.",
            start: 13.3,
          },
          {
            caption: "This screen scans item codes, customer cards and barcodes. Choose Price check to look a card up without adding anything to stock.",
            start: 19.9,
          },
          {
            caption: "Type the set and number, like sv151 199, or the card's name, then press Enter.",
            start: 28.9,
          },
          {
            caption: "Pick the right card from the matches.",
            start: 36.93,
          },
        ],
      },
      {
        title: "Where it comes from",
        start: 41.43,
        steps: [
          {
            caption: "Here is the card and its market value in pounds. The shop's offer is worked out from this figure.",
            start: 43.63,
          },
          {
            caption: "The value is for one finish at a time. Normal is chosen here, so choose holo if the customer's card is holo.",
            start: 51.23,
          },
          {
            caption: "Under Sources, the shop tries four places in order. First is a UK sold price that staff have entered, and this card has none.",
            start: 59.73,
          },
          {
            caption: "Second is eBay UK asking prices, with 15% taken off. It is marked Stale, which means it is too old to use.",
            start: 68.73,
          },
          {
            caption: "Third is Cardmarket, the first fresh figure, so it is marked Chosen. It is priced in euros, so the pounds come first, with the euros and the rate underneath.",
            start: 77.23,
          },
          {
            caption: "Last is TCGplayer, priced in dollars and converted to pounds the same way. It is only used when the sources above have nothing fresh.",
            start: 86.23,
          },
          {
            caption: "Each line ends with a date, and Stale marks a figure that is too old. The note warns when the exchange rate is old, and Refresh asks for newer prices.",
            start: 95.23,
          },
        ],
      },
      {
        title: "The offer",
        start: 104.23,
        steps: [
          {
            caption: "What we would offer is the shop's price for this card. Cash is what you would pay out, and Credit is what you would give as store credit.",
            start: 106.43,
          },
          {
            caption: "A near-mint card, NM, is worth the full market value of £253.02. The shop would offer £152.00 in cash or £190.00 in credit.",
            start: 113.43,
          },
          {
            caption: "Each row down is a worse condition, and the value and both offers fall with it. A damaged card, DMG, is worth £75.91, so the offer is £45.50 cash or £57.00 credit.",
            start: 122.23,
          },
          {
            caption: "In stock shows whether the shop already holds this card. Here there is one holo copy at £324.99.",
            start: 131.23,
          },
        ],
      },
      {
        title: "Add a UK sold price",
        start: 138.53,
        steps: [
          {
            caption: "If you have checked what it really sold for in the UK, press Add UK comp. It then leads the other sources.",
            start: 140.73,
          },
          {
            caption: "Type what a near-mint copy sold for on ebay.co.uk. It leads every other source for 30 days.",
            start: 149.73,
          },
          {
            caption: "Paste the link to the eBay listing, so anyone can check the sale. It must be an ebay.co.uk item link.",
            start: 158.2,
          },
          {
            caption: "The sale date starts as today. Change it if the card sold earlier.",
            start: 167.2,
          },
          {
            caption: "Press Save comp.",
            start: 173,
          },
          {
            caption: "UK sold comp is now first and marked Chosen, so the market value and every offer use £265.00. The Listing link opens the sale.",
            start: 176.4,
          },
        ],
      },
      {
        title: "Check recent sales",
        start: 185.4,
        steps: [
          {
            caption: "The holo version has its own prices and no UK sold price yet. Choose holo to price it.",
            start: 187.6,
          },
          {
            caption: "Search eBay sold opens eBay UK's sold and completed listings for this card in a new tab. When you find a sale you trust, copy its link into Add UK comp.",
            start: 195.4,
          },
          {
            caption: "No time to look? Press Ask an agent and Gandalf researches recent UK sales for you.",
            start: 204.4,
          },
          {
            caption: "The request is sent. The status moves from Waiting for an agent to Gandalf is looking, then shows what it found.",
            start: 211.6,
          },
          {
            caption: "Gandalf found three UK sales. Each row has the date, the listing title and the price, with a Listing link so you can check it yourself.",
            start: 219.8,
          },
          {
            caption: "These sales are now UK sold comps, so UK sold comp leads the sources and the newest sale sets the market value.",
            start: 227.8,
          },
        ],
      },
      {
        title: "Retro games",
        start: 236.3,
        steps: [
          {
            caption: "Retro games are priced on the Buy-in screen. Open Trade.",
            start: 238.5,
          },
          {
            caption: "Press New buy-in. Nothing is paid out until you finish the buy-in.",
            start: 243.9,
          },
          {
            caption: "Say who is selling. Scan their Guild card, or type their code and press Enter.",
            start: 249.9,
          },
          {
            caption: "Press Add items.",
            start: 258,
          },
          {
            caption: "Choose Retro.",
            start: 261.4,
          },
          {
            caption: "Choose the console first, here SNES PAL box. Without it the game cannot be priced.",
            start: 264.8,
          },
          {
            caption: "Type the game's name.",
            start: 271.7,
          },
          {
            caption: "Choose the game from the list.",
            start: 276.2,
          },
          {
            caption: "The market value fills in by itself, with where it came from and how old it is. The cash and credit offers sit beside it.",
            start: 280.4,
          },
          {
            caption: "Press the line under the market value to see every source.",
            start: 288.4,
          },
          {
            caption: "For retro games the order is UK sold comp, PriceCharting PAL, eBay UK asking, then PriceCharting NTSC. Search eBay sold and Ask an agent are here too.",
            start: 294.1,
          },
          {
            caption: "How complete the game is changes its value. Choose Loose for the cartridge on its own.",
            start: 303.1,
          },
          {
            caption: "Loose is worth £18.00, against £70.50 for CIB, which is complete in box. The offers fall to £8.00 in cash or £11.00 in credit.",
            start: 310.3,
          },
        ],
      },
    ],
  },
]
