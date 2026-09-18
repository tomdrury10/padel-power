/* ============================================================
   Padel Power · Studio Manager — user guides
   ------------------------------------------------------------
   Step by step articles for the people who use the dashboard.
   Each guide is tagged with the roles it applies to; instructors
   only see the ones they can actually act on.
   ============================================================ */

const GUIDE_CATS = ['Getting started', 'Classes', 'Bookings', 'Enquiries', 'Running the studio', 'Leagues', 'Kids Zone'];

const GUIDES = [
  /* ---------- Getting started ---------- */
  {
    id: 'signing-in',
    cat: 'Getting started',
    roles: ['admin', 'instructor'],
    title: 'Signing in and finding your way around',
    intro: 'Studio Manager is the staff side of the website. You sign in with your own email and password, and what you see depends on whether you are an instructor or an admin.',
    steps: [
      'Go to padelpower.uk/admin (or tap Admin Login at the very bottom of any page on the site).',
      'Enter your email address and password.',
      'You stay signed in on that device, so you only have to do this once per phone, tablet or computer.',
      'The menu down the left hand side is how you move around. Whatever you open, the clock in the top corner tells you the date and time the studio is working to.',
    ],
    notes: [
      'Forgotten your password? Use the forgot password link on the sign in page. The reset email comes from the website, so check your junk folder if it does not arrive within a minute.',
      'Sign out is at the bottom of the left hand menu, under your email address.',
    ],
  },
  {
    id: 'who-can-do-what',
    cat: 'Getting started',
    roles: ['admin', 'instructor'],
    title: 'Who can do what',
    intro: 'There are two kinds of staff login. This is the difference, so you know whether something is missing or simply not yours to do.',
    steps: [
      'Instructors see three things: Schedule, Bookings and Settings, plus these guides.',
      'On the Schedule an instructor sees every class in the building, but can only edit or cancel the classes they are teaching themselves. On someone else’s class the buttons are replaced by a line telling you who teaches it.',
      'Under Bookings an instructor sees only the people booked onto their own classes.',
      'Under Settings an instructor gets the password form and nothing else.',
      'Admins see everything: Overview, Schedule, Bookings, Enquiries, Reports, Leagues and the full Settings page, and can act on any class.',
    ],
    notes: [
      'This is enforced by the system itself, not just hidden on screen, so there is nothing to worry about if an instructor goes looking.',
      'If you are an instructor and your own classes are not showing as yours, your login has not been linked to your instructor record yet. Message the studio and it takes a minute to fix.',
    ],
  },
  {
    id: 'reading-schedule',
    cat: 'Getting started',
    roles: ['admin', 'instructor'],
    title: 'Reading the schedule',
    intro: 'The Schedule is the week at a glance, six in the morning to nine at night, one column per day. Almost everything you will ever do starts here.',
    steps: [
      'Use the arrows either side of Today to move between weeks. Today jumps you straight back.',
      'Every class block shows the start time, how many beds are booked out of how many, and who is teaching it.',
      'The colours are class types. The key sits just above the grid.',
      'A plus sign after the instructor’s name means it is a one off class added for that date only, rather than part of the usual weekly pattern.',
      'Click any class to open its panel on the right, where you can see who is booked on.',
    ],
    notes: [
      'A cancelled class stays visible to staff, greyed out and marked Cancelled, so you can see what happened. Members no longer see it at all.',
      'The little coloured dot is the status: Confirmed, Full, Needs more bookings, or Below minimum if it is inside the cutoff and still short.',
    ],
  },
  {
    id: 'password',
    cat: 'Getting started',
    roles: ['admin', 'instructor'],
    title: 'Changing your password',
    intro: 'You can change your own password at any time without asking anyone.',
    steps: [
      'Open Settings from the left hand menu.',
      'Find the Your account card.',
      'Type your current password, then your new one twice.',
      'Press Update password. You stay signed in on this device.',
    ],
    notes: ['Your new password needs to be at least 8 characters and different from the old one.'],
  },

  /* ---------- Classes ---------- */
  {
    id: 'add-class',
    cat: 'Classes',
    roles: ['admin'],
    title: 'Adding a class, once or every week',
    intro: 'Everything to do with classes happens on the Schedule. You can add a one off, or set up a class that repeats every week from now on.',
    steps: [
      'Open Schedule and press Add class in the top right.',
      'Pick the day. The list shows the week you are currently looking at, so move the week first if you need a different one.',
      'Set the start time and choose the class type.',
      'Choose the instructor from the dropdown. Only active instructors appear here.',
      'Under Repeats, choose Just this date for a one off, or Every week to add it to the regular timetable from that day onwards.',
      'Press Add to schedule. It appears on the public booking page immediately.',
    ],
    notes: [
      'Every class is one hour long.',
      'If there is already a class at that time on that day it will tell you rather than double booking the studio.',
      'Choosing Every week asks you to confirm, because it changes the timetable for good.',
      'Need a class type that does not exist yet? Add it under Settings first.',
    ],
  },
  {
    id: 'move-class',
    cat: 'Classes',
    roles: ['admin', 'instructor'],
    title: 'Moving a class to a different time or day',
    intro: 'Classes can be moved without losing the people already booked on. They are moved with the class and told automatically.',
    steps: [
      'Open Schedule and click the class you want to move.',
      'Press Edit class in the panel on the right.',
      'Change the start time, the instructor, or both.',
      'Admins can also choose whether this applies to just this class or to that slot every week from now on.',
      'Press Save changes.',
    ],
    notes: [
      'Admins can also simply drag a class block to a different day or time on the grid, then confirm.',
      'Anyone already booked is moved across automatically and gets a text telling them the class has changed.',
      'Instructors can move their own classes, for that date only. Changing the permanent weekly pattern is an admin job.',
      'If something is already booked into the time you are moving to, it will stop you and ask for a different slot.',
    ],
  },
  {
    id: 'cancel-class',
    cat: 'Classes',
    roles: ['admin', 'instructor'],
    title: 'Cancelling a class',
    intro: 'Use this when a class is not going ahead on a particular date. Everything that needs to happen for the people booked on happens automatically.',
    steps: [
      'Open Schedule and click the class.',
      'Press Cancel class in the panel on the right.',
      'Read the confirmation carefully. It tells you how many people are booked, how many will be refunded, and lists their names and numbers.',
      'Confirm.',
    ],
    notes: [
      'The class disappears from the public booking page straight away.',
      'Everyone booked on gets a cancellation text automatically.',
      'Anyone who paid by card is refunded automatically. Anyone who used a class credit gets that credit put back on their account.',
      'It is still worth a personal message to anyone booked on. The confirmation box gives you their names and numbers so you can copy them.',
      'Cancelled a class by mistake? An admin can press Put class back on. Note that the bookings are not restored, so those members would need booking back in.',
    ],
  },
  {
    id: 'remove-series',
    cat: 'Classes',
    roles: ['admin'],
    title: 'Taking a weekly class off the timetable for good',
    intro: 'This is different from cancelling. Cancelling removes one date. This removes the slot from every week from now on, and deals with anyone already booked at the same time.',
    steps: [
      'Open Schedule and click one of the classes in that weekly slot.',
      'Press Remove series.',
      'Read the warning and confirm.',
      'It then tells you how many bookings were cancelled and how many card refunds went out.',
    ],
    notes: [
      'Every upcoming date of the slot that has bookings is cancelled properly: those members get a text, card payments are refunded to the card automatically, and class credits go back on the member’s account.',
      'The instructor gets a cancellation notice for each affected date too.',
      'A one off class that happens to sit at the same time on one of those days is a separate class and is left alone.',
      'To take off a single date instead, use Cancel class.',
    ],
  },

  /* ---------- Kids Zone ---------- */
  {
    id: 'softplay-sessions',
    cat: 'Kids Zone',
    roles: ['admin'],
    title: 'Putting Kids Zone sessions on the timetable',
    intro: 'The Kids Zone is booked slot by slot and you decide which slots exist. Joe\'s pattern is supervised at the weekend, 08:00 to 16:00, and unsupervised midweek, 09:00 to 17:00, where a parent stays in the room. Sessions are 60, 90 or 120 minutes.',
    steps: [
      'Open Kids Zone in the left hand menu. It is the same week and month calendar as Pilates.',
      'Press Add sessions.',
      'Pick the date, start time and length (60, 90 or 120 minutes), then choose the type.',
      'Unsupervised is the midweek one: a shared room, parents stay with their own children. Supervised is the weekend one, run by our team. Exclusive hire gives one booking the whole room, and is normally arranged by email rather than sold online.',
      'Capacity is the most children that slot takes at once.',
      'Repeat weekly puts the same slot on for the next 4, 8 or 12 weeks in one go.',
      'Press Add to the timetable. It is on the public Kids Zone page straight away.',
    ],
    notes: [
      'Nothing sells online until Online booking open is ticked in the Kids Zone settings and the price for that type is set. Add your sessions first, then flip the switch on opening day.',
      'Every type is priced per child per hour, so a 90 minute session costs one and a half times the hourly price and two hours costs double.',
      'Supervised sessions still need the minimum number of children to go ahead and are cancelled automatically with refunds if they do not get there. Unsupervised sessions have no minimum.',
      'One session per start time. If you need two different types at the same time, that is two different start times.',
    ],
  },
  {
    id: 'softplay-day',
    cat: 'Kids Zone',
    roles: ['admin'],
    title: 'On the day: bookings, check-in and cancelling',
    intro: 'The Kids Zone calendar works exactly like the Pilates schedule: week or month view, click a session and the panel on the right shows everything about it.',
    steps: [
      'The list shows each parent, their mobile, how many children and any names they gave, and whether they paid online or are paying at the desk.',
      'Press Check in as each family arrives. The count at the top shows how many children are here.',
      'Desk booking adds a family who rang up or walked in. They are never charged online; take the money however you normally would.',
      'Remove booking cancels one family. A card payment is refunded automatically.',
      'Cancel session cancels the whole slot: everyone booked is texted and card payments are refunded automatically.',
    ],
    notes: [
      'Supervised sessions under the minimum are cancelled automatically at the confirm or cancel point (normally 24 hours before), the same as Pilates. Hire slots are never auto-cancelled.',
      'Once a supervised session has reached its minimum it stays open to book online until the late joins cutoff, normally an hour before.',
      'Parents can cancel themselves up to 24 hours before from their account or the link in their text. Inside 24 hours they have to call.',
    ],
  },

  {
    id: 'softplay-settings',
    cat: 'Kids Zone',
    roles: ['admin'],
    title: 'Kids Zone prices, ages and the online switch',
    intro: 'The card at the bottom of the Kids Zone page. Nothing sells online until the price for that type of session is set and Online booking open is ticked.',
    steps: [
      'Every price is per child per hour. A 90 minute session bills one and a half times it, two hours bills double, and that is worked out automatically.',
      'Supervised price is the weekend one, run by our team. It starts blank on purpose: supervised sessions cannot be sold until it is filled in.',
      'Unsupervised price is the midweek one, where a parent stays in the room.',
      'Exclusive hire price is for one booking taking the whole room. Parties and exclusive hire are arranged by email, so this is mostly for bookings you enter at the desk.',
      'Minimum children to run only applies to supervised sessions: below it, the session is cancelled automatically with refunds at the cancellation cutoff. Unsupervised sessions have no minimum.',
      'Default capacity is what a new session starts at. You can change it per session when you add one.',
      'Age from and Age to are shown on the website. Joe is confirming the range, so check with him before changing it.',
      'Tick Online booking open and press Save Kids Zone settings when you are ready to sell. Until then the page says opening soon and nothing can be bought.',
    ],
    notes: [
      'The website shows whether a session is supervised or not on the list and again on the payment step, so parents cannot miss it.',
      'The grip socks rule and no food or drink in the play zone are printed on the website. Grip socks are sold at reception.',
    ],
  },

  /* ---------- Bookings ---------- */
  {
    id: 'see-whos-booked',
    cat: 'Bookings',
    roles: ['admin', 'instructor'],
    title: 'Seeing who is booked onto a class',
    intro: 'Useful before you walk into the studio, so you know who is coming and whether anyone has flagged an injury.',
    steps: [
      'Open Schedule and click the class.',
      'The panel on the right lists everyone booked, with their phone number and email.',
      'The row of small blocks shows the beds: filled ones are taken.',
      'Next to each person you will see how they booked, and whether they have a health waiver on file.',
    ],
    notes: [
      'Instructors see this for their own classes. Admins see it for any class.',
      'You can also press Bookings in the left hand menu for a searchable list of everything, rather than class by class.',
    ],
  },
  {
    id: 'check-in',
    cat: 'Bookings',
    roles: ['admin', 'instructor'],
    title: 'Checking people in',
    intro: 'A tick against each person who actually turns up, so the studio knows who came and who did not.',
    steps: [
      'Open Schedule and click the class. From three hours before it starts, a Check in button appears next to each name.',
      'Press Check in as each person arrives. It turns green and reads Here.',
      'Pressed the wrong one? Press it again to undo.',
      'If everyone on the list has arrived, Everyone is here ticks them all in one go.',
      'The line under the beds shows how many of the booked members have been checked in.',
    ],
    notes: [
      'Instructors can check in their own classes. Admins can do it for any class, including after the class has finished.',
      'Anyone left unticked stays as booked but not checked in, which is how the studio sees who did not turn up. A tick never charges or refunds anything.',
      'Under Bookings, people who were checked in show a green Here tag.',
    ],
  },
  {
    id: 'take-booking',
    cat: 'Bookings',
    roles: ['admin'],
    title: 'Booking someone in at the desk or over the phone',
    intro: 'For when somebody books in person or rings up rather than doing it themselves online.',
    steps: [
      'Press New booking in the top right. You can do this from any page.',
      'If you started from a class, that class is already filled in. Otherwise pick it from the list.',
      'Enter their name, email address and mobile number.',
      'Choose whether it came in at the Front desk or by Phone.',
      'Press Confirm booking.',
    ],
    notes: [
      'If that email has never signed a health waiver, the waiver form opens first. Hand the device to the member to fill in and sign before the booking is taken.',
      'Front desk and phone bookings are never charged online. Take the payment however you normally would.',
      'A class that is full or has already started will not appear in the list. Unlike online booking, the desk can add someone right up to the start.',
    ],
  },
  {
    id: 'remove-booking',
    cat: 'Bookings',
    roles: ['admin'],
    title: 'Removing a booking, and what happens to their money',
    intro: 'When one person cannot make it, rather than the whole class being off.',
    steps: [
      'Find them either in the class panel on the Schedule, or in the Bookings list.',
      'Press the small cross next to their name.',
      'The confirmation tells you exactly what will happen to their payment. Read it, then confirm.',
    ],
    notes: [
      'If they paid by card, the refund goes back to that card automatically. You do not need to touch Stripe.',
      'If they used a class credit, the credit goes back onto their account automatically.',
      'If it was a front desk or phone booking, nothing financial happens, because nothing was taken online.',
      'This frees the bed immediately, so somebody else can book it.',
    ],
  },
  {
    id: 'waivers',
    cat: 'Bookings',
    roles: ['admin', 'instructor'],
    title: 'Health waivers',
    intro: 'Everyone signs a health questionnaire once, the first time they book. It is worth a look before you teach somebody new.',
    steps: [
      'Open a class on the Schedule, or the Bookings list.',
      'Next to each person you will see either Waiver, with a tick, or No waiver.',
      'Click Waiver to read what they have told us: injuries, medical conditions, pregnancy, emergency contact and anything else they flagged.',
    ],
    notes: [
      'It is one waiver per email address, not per booking, so they only ever fill it in once.',
      'If somebody shows No waiver and an admin is booking them in at the desk, the form appears automatically and they sign on the spot.',
      'Treat what is in there as confidential. It is health information.',
    ],
  },

  /* ---------- Enquiries ---------- */
  {
    id: 'enquiries',
    cat: 'Enquiries',
    roles: ['admin'],
    title: 'Answering an enquiry from the website',
    intro: 'Every message sent through the contact form on the website lands here. The number on the menu is how many are still unanswered.',
    steps: [
      'Open Enquiries. It opens on New, which is everything nobody has dealt with yet. All shows the lot.',
      'Use the dropdown on an enquiry to assign it to Grace or Joe, so it is clear who is picking it up.',
      'The row of filters at the top lets you show only yours, or only the ones nobody has taken.',
      'Press Reply, type your answer, then press Open in Outlook.',
      'Outlook opens with their address, the subject and your message already filled in, and their original message quoted underneath. Check it over and send it from there.',
      'The enquiry is marked handled automatically once you have done that, and your reply is saved against it so the rest of the team can see what was said.',
    ],
    notes: [
      'Nothing sends by itself. You always get the final look in Outlook before it goes.',
      'Because the message came from the website form rather than as an email, it opens as a fresh message rather than threading onto an existing conversation. That is normal.',
      'Mark handled on its own is there for when you dealt with something by phone instead.',
    ],
  },

  /* ---------- Running the studio ---------- */
  {
    id: 'overview',
    cat: 'Running the studio',
    roles: ['admin'],
    title: 'The Overview page',
    intro: 'The first thing you see when you sign in as an admin. It is the day at a glance.',
    steps: [
      'The four tiles across the top: classes on today, beds booked today, how full the next seven days are, and how many classes still need more bookings.',
      'Today lists every class today in order. Click one to jump to it on the Schedule.',
      'Next class shows what is coming up and how long until it starts, with a shortcut to add a booking.',
      'Latest bookings is a live feed of who has booked recently and how.',
    ],
    notes: ['Anything flagged as needing more bookings is worth a push on WhatsApp or social, because classes below the minimum do not run.'],
  },
  {
    id: 'reports',
    cat: 'Running the studio',
    roles: ['admin'],
    title: 'Reports: how full classes are and what they make',
    intro: 'Occupancy and money, by class, by class type and by instructor.',
    steps: [
      'Open Reports and choose a period: the last 7 or 30 days for what has happened, or the next 14 or 60 days for what is coming.',
      'The tiles give you classes run, beds filled, occupancy as a percentage, revenue, and profit after instructor costs.',
      'Occupancy by class type shows which kinds of class actually fill.',
      'Instructor breakdown shows classes taught, beds filled, revenue, cost and profit per instructor.',
      'Class by class is the detail underneath all of it.',
    ],
    notes: [
      'Cost is the instructor’s hourly rate for each one hour class. Set those rates under Settings, or everyone is assumed to be on £40 an hour.',
      'Revenue counts card payments taken online. Front desk and phone bookings show no revenue here, because that money was taken elsewhere.',
      'On a future period, profit is a forecast rather than a result: the cost of every scheduled class is counted, but only money already taken shows as revenue.',
      'An instructor whose classes all fall outside the period you picked will not appear at all. If someone seems missing, widen the range.',
      'Reports are admin only. Instructors cannot see pay rates or takings, including their own colleagues’.',
    ],
  },
  {
    id: 'instructors',
    cat: 'Running the studio',
    roles: ['admin'],
    title: 'Adding and managing instructors',
    intro: 'The instructor list feeds the dropdowns on every class, and the cost side of the reports.',
    steps: [
      'Open Settings and find the Instructors card.',
      'To add somebody: type their name, their hourly rate, and their email and mobile, then press Add instructor.',
      'Press Edit next to anyone to update their contact details or rate.',
      'Press Deactivate to take somebody off the dropdowns without losing their history. Reactivate brings them back.',
    ],
    notes: [
      'The email and mobile matter: that is where the automatic notice goes when one of their classes is cancelled. Without them, nothing reaches the instructor.',
      'The hourly rate is what the financial report uses to work out cost and profit.',
      'Adding somebody here does not give them a login. That is a separate step, so ask if a new instructor needs access to Studio Manager.',
      'Instructors cannot see this card, or anybody’s pay rate.',
    ],
  },
  {
    id: 'class-types-prices',
    cat: 'Running the studio',
    roles: ['admin'],
    title: 'Class types and prices',
    intro: 'Class types are the kinds of class you can put on the timetable. Each one can carry a price.',
    steps: [
      'Open Settings. Class types is the first card.',
      'To add one: give it a name, a level, and a short description that members will read, then press Add type.',
      'To set a price, type it into the price box on that class type and press Save prices.',
      'Leave a price blank to make that class free to reserve.',
    ],
    notes: [
      'A price means online bookings pay by card at the time of booking. Front desk and phone bookings are never charged online.',
      'Only class types you have added yourself can be deleted. The core ones cannot.',
      'Deleting a class type removes scheduled classes of that type from the timetable, so check the Schedule first.',
    ],
  },
  {
    id: 'studio-rules',
    cat: 'Running the studio',
    roles: ['admin'],
    title: 'Studio rules, class packs and mobile verification',
    intro: 'The settings that drive how booking works for everybody. Changes take effect immediately on the public booking page.',
    steps: [
      'Open Settings and find the Studio rules card.',
      'Beds per class is the capacity of the studio.',
      'Minimum to run is how many bookings a class needs. Below that, it is cancelled automatically at the confirm or cancel point, and everyone is told and refunded.',
      'Cancel online until is how many hours before a class members can still cancel themselves, normally 24. Cancel short classes at is when a class still under its minimum is cancelled automatically, normally 12 hours before; until then it stays open to book, so a class that reaches its minimum by then goes ahead.',
      'Late joins close is when online booking finally shuts on a class that is going ahead, normally 1 hour before. Between the two points anyone can still book onto a confirmed class.',
      'Booking window is how far ahead members can book.',
      'Classes per pack, pack price and pack valid for set up the block of classes members buy from their account.',
      'Press Save rules.',
    ],
    notes: [
      'Changing the pack settings only affects packs bought from that point on. Packs people already own keep the size and expiry they were sold with.',
      'The mobile verification tick makes members confirm their number by text before they can book.',
      'These settings are admin only, because they affect what everybody pays.',
    ],
  },

  /* ---------- Leagues ---------- */
  {
    id: 'leagues',
    cat: 'Leagues',
    roles: ['admin'],
    title: 'Leagues: what comes from Playtomic and what you set',
    intro: 'Leagues are created in Playtomic and appear in Studio Manager on their own within the hour. Playtomic owns the name, the start date, the closing time and the number of places. You own the prices, the number of weeks and whether registration is open.',
    steps: [
      'Open Leagues. Each league is a card in League setup. The line under the name tells you when it opens, when it closes and how many places are taken.',
      'Fill in Member £/week, Non-member £/week and Weeks, then press Save. Until all three are set the card says needs prices and weeks to open, and the league does not appear on the website at all.',
      'Season starts is read only for a Playtomic league because Playtomic decides it. If it looks wrong, fix it in Playtomic and press Sync now.',
      'Sync now at the top of the page pulls the latest from Playtomic straight away instead of waiting for the hourly check.',
      'Club members is the list of players who get the member price, matched on their email or mobile. Players with a club membership on Playtomic get it automatically, so this list is for anyone that misses.',
    ],
    notes: [
      'Prices are per player per week and are fixed for a player at the moment they register.',
      'The registration page on the website only lists leagues that are open right now. A league that is not ready, or not open yet, is simply not shown.',
    ],
  },
  {
    id: 'league-windows',
    cat: 'Leagues',
    roles: ['admin'],
    title: 'When registration opens and closes',
    intro: 'Registration runs itself from the Playtomic start date. You only step in when you want to override it.',
    steps: [
      'Registration opens to everyone at 6pm, 21 days before the league starts.',
      'Players who were in one of our recent leagues get a five day head start, so for them it opens at 6pm, 26 days before. The website checks the Playtomic profile they paste against our last leagues.',
      'It closes at the enrolment end date set in Playtomic, and closes early on its own when every place is taken. If a place frees up while the window is still open, it reopens on its own.',
      'The pill on each card shows where it is: Not open yet, Returning players only, Open, Full or Closed.',
      'Registration set to Automatic (dates and places) does all of the above. Force open ignores the dates and the places. Force closed shuts it whatever the dates say.',
      'Open to everyone from lets you pick your own date and time for the general opening instead of 21 days before. Leave it blank for the normal rule. The head start still runs five days ahead of whatever you pick.',
    ],
    notes: [
      'A full league still lets a partner join a player who is already registered and waiting for one, so a doubles pair can complete.',
      'Everything is worked out in UK time, so the 6pm is 6pm here whatever the clocks are doing.',
    ],
  },
  {
    id: 'league-registrations',
    cat: 'Leagues',
    roles: ['admin'],
    title: 'Registrations, Playtomic and partners',
    intro: 'The table under League setup is everyone who has registered. Search by player, email or mobile, filter by league or status, and use the Action menu on a row to sort things out.',
    steps: [
      'The status says what is holding a registration up: Awaiting partner, Ready for Playtomic, Payment failed or Card not saved.',
      'Once a player has saved a card they are added to the Playtomic league automatically within 15 minutes, and made a customer in Playtomic Manager with their email and mobile. Customer ✓ on the row means that worked.',
      'Customer failed means Playtomic refused and the website will try again later. Customer may not have been created means Playtomic answered with a different account, usually a different email: check the customer in Manager, tidy it up, then choose Mark customer sorted.',
      'Retry Playtomic add is for a registration that got stuck while being added to the league. Mark added to Playtomic is for one you added by hand in Manager.',
      'Set as member switches a player to the member price before their first payment. Set weekly price changes the price for that one player.',
      'Copy partner link gives you the link a doubles player sends their partner. Link a partner pairs two registrations yourself, and Unlink partner separates them.',
      'Stop future payments ends the weekly billing but keeps the player in the league. Cancel registration removes them from the league on Playtomic, ends billing, frees the place and texts them.',
      'History shows every step that has happened to that registration.',
    ],
    notes: [
      'Players are texted when their registration is confirmed and when it is cancelled. A failed weekly payment texts them a link to update their card.',
      'The Playtomic link a player pastes is what gets added to the league, so if someone pasted the wrong profile, cancel and ask them to register again with the right one.',
    ],
  },
];

/* ---------- rendering ---------- */
let gdQuery = '', gdCat = '', gdOpen = new Set();

function guidesForRole() {
  const role = isAdmin() ? 'admin' : 'instructor';
  return GUIDES.filter(g => g.roles.includes(role));
}

function renderGuides() {
  const mine = guidesForRole();
  const cats = GUIDE_CATS.filter(c => mine.some(g => g.cat === c));

  $('gdCatFilter').innerHTML = [`<button class="${gdCat ? '' : 'on'}" data-cat="">All</button>`]
    .concat(cats.map(c => `<button class="${gdCat === c ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`)).join('');
  $('gdCatFilter').querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => { gdCat = b.dataset.cat; renderGuides(); }));

  const q = gdQuery.trim().toLowerCase();
  const hay = g => [g.title, g.intro, ...(g.steps || []), ...(g.notes || [])].join(' ').toLowerCase();
  let list = mine;
  if (gdCat) list = list.filter(g => g.cat === gdCat);
  if (q) list = list.filter(g => hay(g).includes(q));

  const byCat = {};
  list.forEach(g => { (byCat[g.cat] = byCat[g.cat] || []).push(g); });

  $('gdList').innerHTML = GUIDE_CATS.filter(c => byCat[c]).map(c => `
    <div class="d2-card gd-group">
      <div class="d2-card-head"><h2>${esc(c)}</h2></div>
      ${byCat[c].map(g => {
        const open = gdOpen.has(g.id) || !!q;
        return `
        <article class="gd-item ${open ? 'open' : ''}" data-id="${g.id}">
          <button class="gd-head" data-toggle="${g.id}">
            <span class="gd-title">${esc(g.title)}</span>
            <span class="gd-chev" aria-hidden="true">${open ? '−' : '+'}</span>
          </button>
          <div class="gd-body" ${open ? '' : 'hidden'}>
            <p class="gd-intro">${esc(g.intro)}</p>
            <ol class="gd-steps">${(g.steps || []).map(s => `<li>${esc(s)}</li>`).join('')}</ol>
            ${(g.notes || []).length ? `<div class="gd-notes"><h4>Worth knowing</h4><ul>${g.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
          </div>
        </article>`;
      }).join('')}
    </div>`).join('');

  $('gdEmpty').hidden = list.length > 0;

  $('gdList').querySelectorAll('.gd-head').forEach(b =>
    b.addEventListener('click', () => {
      const id = b.dataset.toggle;
      if (gdOpen.has(id)) gdOpen.delete(id); else gdOpen.add(id);
      renderGuides();
    }));
}

$('gdSearch').addEventListener('input', e => { gdQuery = e.target.value; renderGuides(); });
