# 🌸 Life Tracker

A static website (HTML + CSS + JS, no build step) with **invite-only accounts**. Each person uploads their yearly Excel tracker; it is converted to a Google Sheet in **your** Google Drive and shown in the site with in-depth analysis. It runs on **GitHub Pages**.

```
Browser (GitHub Pages)
   │  Firebase sign-in  ───────────────▶  Firebase Authentication   (passwords live here, hashed)
   │  member / year list ──────────────▶  Firestore                 (members, document_link, invites)
   │  ID token + year ─▶  Apps Script  ─▶  Google Drive / Sheets    (MasterFolder/<UserName>/<Year>)
                            └─ verifies the token, reads Firestore as that user, writes document_link
```

> 📚 **Architecture diagrams, data model, features and changelog:** see the [`Documentation/`](Documentation/README.md) folder.

## What's in the folder

| File | What it is |
|---|---|
| `index.html`, `style.css`, `app.js` | The website. |
| `account.js` | Firebase sign-in, registration, change password, Firestore reads. |
| `astro.js` | Astrology for linked couples: rasi charts and the daily reading, calculated in the browser. |
| `food.js` | Food log: calories, protein, carbs and fat per meal, AI estimates and the daily target. |
| `pwa.js`, `sw.js`, `manifest.webmanifest`, `icons/` | Web app: install to the home screen, quick start, offline page, update prompt. |
| `config.js` | **You fill this in:** Apps Script URL + Firebase web config. |
| `Code.gs`, `Morning.gs`, `appsscript.json` | The Apps Script bridge (Drive upload + Sheet reads/writes). |
| `firestore.rules` | Security rules — the rules are what stop people seeing each other's files. |

## How it works

- **Invite-only.** The admin (you) adds an email under **Admin → Invite**. Only that email can register; the person picks a **username** (3–30 letters/numbers/`_`/`-`), which can never be changed. Usernames are unique.
- **Upload.** On **Upload**, a person picks a year and an `.xlsx`. The script converts it to a Google Sheet at `MasterFolder/<UserName>/<Year>` and records it in Firestore. The file must really contain that year's dates.
- **One upload per year.** If 2026 already exists for a person, it cannot be uploaded again. A different year is accepted. (The admin can remove a wrong row under **Admin → Members** so the year can be uploaded again.)
- **Year picker.** The header lists only the years you have uploaded. Pick one and the Today / Buy list / Insights views (Day, Week, Month) show that file.
- **Privacy.** A person can only open their own files — enforced by Firestore rules *and* by the script, which never accepts a file link from the browser. Drive files are private to your Google account.
- **Admin view.** The admin gets a person picker in the header and an **Admin** tab: pick anyone and see their Today, Buy list and Insights, **read-only**.

### Firestore tables

| Collection | Document id | Fields |
|---|---|---|
| `members` (registration) | Firebase user id | `userName`, `email`, `gender` (`female` / `male` / `other`), `role` (`user` / `admin`), `createdAt` |
| `document_link` (fact table) | `<userId>_<year>` | `userId`, `userName`, `year`, `driveFileId`, `driveLink`, `uploadedAt` |
| `invites` | the email (lower-case) | `email`, `invitedAt` |
| `usernames` | lower-cased username | `uid` (reserves the name) |
| `push_tokens` | hash of the token | `uid`, `email`, `token`, `device`, `updatedAt` (one row per phone with notifications on) |
| `astro_pairs` | auto id | `members` (two user ids), `names`, `births` (per user: `date`, `time`, `place`, `lat`, `lon`, `tz`), `by`, `createdAt`, `updatedAt` |

There is **no password column** — Firebase Authentication stores passwords (hashed); duplicating them in a table would only make a leak worse.

---

## One-time setup (≈25 minutes)

### 1. Firebase

1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project** (Analytics not needed).
2. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable** (leave "Email link" off).
3. **Build → Firestore Database → Create database** → production mode → pick a region near you.
4. Firestore → **Rules** tab → paste the whole of `firestore.rules` → **Publish**.
5. **Project settings (⚙️) → Your apps → `</>` Web** → register an app → copy the `firebaseConfig` values into `config.js` (`apiKey`, `authDomain`, `projectId`, `appId`).
6. Authentication → **Settings → Authorized domains** → add your GitHub Pages domain, e.g. `anchana-techie.github.io` (`localhost` is there already).

### 2. The master folder in Google Drive

This is the folder that will hold one sub-folder per person: `MasterFolder/Person1/2026`, `MasterFolder/Person2/2027`, …

1. Open [drive.google.com](https://drive.google.com) signed in as the Google account that will own everything.
2. **New → New folder** → name it (e.g. `LifeTrackerFiles`). This is *FolderName*.
3. Open the folder. The address bar looks like `https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz` — the part after `/folders/` is the **folder id**. Copy it.
4. **Do not create the person folders or year files yourself** — the script creates `MasterFolder/<UserName>/` the first time that person uploads, and names each file with its year. Do not share this folder with anyone.

### 3. The Apps Script bridge

1. [script.google.com](https://script.google.com) → **New project** → name it `Tracker bridge`.
2. Paste the whole of `Code.gs` into `Code.gs`.
3. **Project Settings (⚙️) → tick "Show appsscript.json manifest file in editor"** → open `appsscript.json` in the editor and replace its contents with the repo's `appsscript.json`. (This enables the Drive service and the permissions the script needs.)
4. **Project Settings → Script properties → Add** three properties:
   - `MASTER_FOLDER_ID` = the folder id from step 2
   - `FIREBASE_PROJECT_ID` = your Firebase project id (same as `projectId` in `config.js`)
   - `FIREBASE_API_KEY` = the `apiKey` from `config.js`
5. Pick any function (e.g. `doGet`) and click **Run** once. Authorise: *Review permissions → your account → Advanced → Go to Tracker bridge (unsafe) → Allow.* ("Unsafe" only means Google has not reviewed your personal script.)
6. **Deploy → New deployment → Web app** → Execute as **Me**, Who has access **Anyone** → Deploy. Copy the **/exec URL** into `scriptUrl` in `config.js`.

> Use the **same Google account** for the Drive folder, the Apps Script and the Firebase project. The script writes to Firestore with that account's permissions (it must be an Owner of the Firebase project, which it is if you created the project).
>
> If an upload ever says *Could not save the file link (403)*: open the Firebase project's linked Google Cloud project, and enable the **Cloud Firestore API**.

When you change `Code.gs` later: **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.** The URL stays the same.

### 3b. Phone notifications (optional, ≈5 minutes)
Lets the admin's messages reach people's phones as real notifications, even when the app is closed. Free (no Blaze plan).
1. Firebase console → ⚙️ **Project settings → Cloud Messaging** → *Web configuration* → **Web Push certificates → Generate key pair**. Copy the key and paste it into `vapidKey` in `config.js` (it is public, not a secret).
2. In the Apps Script editor, replace `Code.gs` **and** `appsscript.json` with the repo's versions (they add the `firebase.messaging` and trigger permissions).
3. Pick **setupPush** in the function list → **Run** → allow the new permissions. This also starts a job every 5 minutes for scheduled messages.
4. **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.**
5. Publish the updated `firestore.rules` (new `push_tokens` table).
For a good-morning nudge at about 9 am (India time) for everyone with notifications on: in the Apps Script editor click **+ → Script**, name it `Morning`, paste the repo's `Morning.gs`, save, and run **setupMorning** once. Run **morningPush** to send one straight away as a test.
6. Each person: **Settings → Phone notifications → Turn on notifications**. On iPhone this only works in the installed app (iOS 16.4 or later): install it first, open it from the home screen, then turn notifications on.

The script must be owned by an account that is an owner of the Firebase project (it sends with that login). If sending fails with "not authorised", run **setupPush** again.

### 4. Publish the site

1. Put this folder in a GitHub repo (with `config.js` filled in) on the `main` branch.
2. Repo **Settings → Pages** → Source: *Deploy from a branch* → `main` → `/ (root)` → Save.
3. After a minute it is live at `https://<you>.github.io/<repo>/`.

### 5. Make yourself the admin (once)

1. In the site's **Firebase console → Firestore → Start collection** `invites` → Document id = **your email in lower-case** → add a field `email` (string) with the same value → Save.
2. Open the site → **Register** with that email and pick your username.
3. Back in Firestore → `members` → open your document → change `role` from `user` to `admin`. (Roles can only be set here; nobody can make themselves admin from the site.)
4. Sign out and in again. You now see the **Admin** tab.

### 6. Upload your first year and invite the other person

1. **Upload** tab → year `2026`, choose your `.xlsx` → **Upload**. It appears in Drive as `MasterFolder/<yourUserName>/2026`.
2. **Admin → Invite** → their email. They register, then upload their own file(s).

---

## Everyday use

1. Sign in, then pick the **year** at the top (only years you uploaded are listed). Admins also get a **person** picker.
2. **Today** — tap a tile to mark it done (tap again to undo). Tiles are grouped into **Morning / Daytime / Evening** (Daily Dos), **Habits**, **Body** (period day + weight) and **Bought today** (this month's buy list first; search to find any product, or add a new one).
   - The week strip at the top jumps between days; each day's ring shows how much you ticked.
   - Switch **Day ↔ Week** to edit a whole week at once in a grid (Daily Dos, Habits, Products, Period).
   - Changes are collected (orange dots) and written together with **Save to sheet**, even across several days.
   - New products are added as a new row at the bottom of the Products sheet.
   - Groups are picked from the item name; change any of them in **Settings → Daily Dos groups** (saved per browser).
3. **Buy list** — choose a month, add products (suggestions come from your Products list, or type a new one), approx cost, and a monthly budget → **Save list**.
   - Items fill `Product-1 / Cost`, `Product-2 / Cost`, … in that month's row. If you add more than 11, new `Product-12 / Cost` columns are added automatically.
   - **Mark bought** puts an `X` in Products on the date you choose. "Bought" status is read back from Products, so ticking it on the Log page counts too.
   - The budget is saved in a small **Buy Settings** sheet (created automatically the first time you set one).
   - Items from earlier months that were never bought show up as "Not bought from earlier months" with a one-click **+ Add**.
4. **Insights** — choose a view and a period (All tracked, last 30/7 days, or a month):
   - **Overview:** completion vs previous period, best streak, next period, weight change, this month's spend, and the main things that stand out.
   - **Daily Dos / Habits:** completion over time with a 7-day average, day-of-week pattern, per-item rate / streaks / trend / best day / last done, a day-by-day heat map, *keystone* items (days you do X, you do more of everything else), weekend vs weekday, and period-day effect.
   - **Period cycle:** detected periods and cycle lengths, spotting kept separate from new cycles, next-period prediction with a ± window, estimated fertile window, today's cycle day and phase, irregularity flags, how habits and weight change by phase.
   - **Weight:** trend line with 7-day average, weekly rate from a best-fit line, range, weigh-in consistency, 30-day projection, and which items go with lower/higher weight the next morning.
   - **Spending & restock:** budget vs planned vs bought per month, over-budget warnings, unplanned purchases, repeat items, biggest planned items, and a restock tracker (average gap between purchases → next expected date → overdue / due soon).

5. **Astrology** (only for people the admin has linked, and for the admin):
   - The admin opens **Astrology**, picks two members, enters each one's birth date, time and place (city search, or coordinates by hand) → **Link and save**. A person can be in one pair at a time. **Edit**, **Charts** and **Unlink** are in the *Linked couples* list.
   - The two people then get an **Astrology** tab with both South Indian rasi charts (lagna, rasi, nakshatra, planets, and where the Moon is today) and a 7-day Moon watch.
   - Each day the Astrology tab gives both people a **Good / Mixed / Careful** rating with advice:
     - **Moon** in the 1st, 7th or 8th from either person's rasi or lagna is a caution (8th from rasi = Chandrashtamam, always *Careful*).
     - **Tara balam**: today's nakshatra counted from the birth nakshatra (Sampat, Kshema, Sadhana, Mitra, Parama Mitra are good; Vipat, Pratyak, Naidhana are not; Janma is mixed).
     - The Moon and Tara decide the rating, using waking hours (6 am to 10 pm).
     - **Gocharam** of Suriyan, Sevvai, Budhan, Guru, Sukran, Sani, Rahu and Ketu, counted from the birth rasi with the traditional good houses, plus Sade Sati, Ashtama Sani, Ardhashtama Sani and Guru balam. These are the background and add advice, but don't change the rating.
     - The day's **tithi, nakshatra, sunrise/sunset, Rahu kalam, Yamagandam and Kuligai** (for the viewer's birth place), and a line for the couple together.
   - The Today banner shows both ratings, the Moon and Rahu kalam (green, amber or red).
   - The first time each person opens the app at or after **8 am**, a pop-up gives both ratings, the Moon and Tara advice, the couple line and Rahu kalam (once a day). The site cannot notify you while it is closed, so it appears when you next open it.
   - Charts use sidereal positions with the Lahiri ayanamsa and mean Rahu/Ketu, calculated in the browser with Astronomy Engine (loaded from jsDelivr only when needed). City search uses the free Open-Meteo geocoding service.

5b. **Assistant:** ask about anything in your tracker, for example *How is my diet going?*, *When is my next period?*, *How are my stars this week?*, *When is Sharan's next Chandrashtamam?*, *How much did I spend this month?* or *Which habits do I skip on weekends?*. It only sends summary numbers to Groq (never notes); astrology covers you and your linked partner (charts and readings only).
6. **Food:**
   - Pick the meal, type what you ate (e.g. *2 idli with sambar, filter coffee*) and tap **Estimate calories**. Groq (the assistant's key) estimates calories, protein, carbs and fat, guided by a built-in list of about 120 common Indian foods. Every number can be corrected before and after saving. **Enter myself** adds an empty row; **Recent** re-adds something you logged before.
   - The daily target uses your latest weight, height (Settings), age and gender with the Mifflin-St Jeor formula and your activity level, then -500 kcal to lose (never below 1200 kcal for women / 1500 for men) or +300 to gain. Protein is 1.2-1.6 g per kg, fat 25% of calories, carbs the rest. Set your date of birth, activity and goal on the Food page; a fixed target overrides the calculation.
   - Saved in the year file: `Food Log` (one row per food) and `Body Settings` (date of birth, activity, goal, target). Estimates count towards the assistant's daily limit.
7. **Weekday / weekend tasks:** a task can apply every day, on Weekdays (Mon–Fri), on Weekends (Sat–Sun) or on picked days (e.g. Mon, Wed, Fri). Set it when adding a task or with ✏️ on the Tasks page. A day marked **Leave** or **Holiday** in Work counts as a weekend day for the Weekdays / Weekends choices (picked days follow the calendar only). On days a task does not apply it is hidden on Today, not counted as missed, and streaks carry over those days; Insights shows those days as *Not scheduled*. Saved in the `Days` column of `Task Settings`.
8. **Editing tasks:** on the Tasks page, ✏️ renames a task or changes its start date (past ticks are kept), ⏹ stops it from a date (hidden from then on, history stays), and **Stopped** lists them with **Restore**. The stop date is the `Stopped from` column in `Task Settings`.

**Try it first:** Settings → *Load demo data* shows every screen with made-up numbers. Nothing is sent anywhere.

**Theme:** the sun/moon button switches between auto, light and dark.

### How "logged days" work
A day with nothing ticked on a sheet is treated as **not logged**, not as "all missed", so forgetting to fill a day doesn't drag your percentages down. The heat map shows those days with a dashed outline.

---

## Install on your phone

Life Tracker is a web app: no APK or app store needed.

- **Android (Chrome):** open the site, go to **Settings → Install app → Install app**. Or use Chrome's ⋮ menu → *Add to Home screen* / *Install app*.
- **iPhone (Safari):** open the site in Safari, tap **Share** → **Add to Home Screen**. The home-screen app keeps its own sign-in, so sign in once more inside it.
- Long-press the home-screen icon on Android for shortcuts to **Today**, **Buy list** and **Astrology**.
- Opens full screen, starts faster (libraries are saved on the phone), and still opens offline. Saving and loading your sheet need a connection.
- After a new version is pushed, the app shows **New version available → Reload**.
- For maintainers: bump `VERSION` in `sw.js` (and the `?v=` numbers in `index.html`) with each release.

### Going back to the version before the web app
The code as it was before this change is saved on the branch **`backup-before-webapp`**. To restore it, revert the web-app commit on `main` (`git revert <commit>`) or reset `main` to that branch, then push. Existing installs remove the service worker on their own only if `sw.js` is replaced by one that unregisters itself, so a full revert should keep a small `sw.js` that does that (ask Claude: "revert the web app").

## Sheet layout the script expects
Sheets are found by name prefix, so the year in the name can change:

| Sheet (name starts with) | Layout |
|---|---|
| `Products…`, `Daily Dos…`, `Habit…` | Row of dates (row 2), item names in column A from row 4, `X` under a date = done/bought |
| `Period…` | Calendar blocks; `X` in the cell directly under a date |
| `Weight…` | Header row with `Date` and `Weight (kg)` columns |
| `Month List…` | Header row `Product-1`, `Product - 1 Cost Approx`, …; one row per month name in column A |
| `Buy Settings` | `Month · Budget (₹) · Notes` (auto-created) |

You can rename items, reorder them, or add new rows in the sheet itself — the site picks them up on the next **Load**.

## Privacy and security
- Passwords are handled only by Firebase Authentication. Nothing secret is in the website code — the Firebase web config in `config.js` is public by design; the Firestore rules protect the data.
- The browser never sends a sheet link. The script verifies the Firebase sign-in, looks up *that person's* `document_link` row (Firestore applies the rules as that person), and only then opens the file. Browsers cannot create or edit `document_link` rows — only the script can — so nobody can point their row at someone else's file.
- Drive files stay private to your Google account; people reach them only through the site.
- The admin view is read-only: the script refuses every save action for another person's file.
- Birth details live in `astro_pairs`. Only the admin can write them, and only the admin and the two people in a pair can read that pair.

## Troubleshooting
| Message | Fix |
|---|---|
| *Setup needed: fill in config.js* | Fill `scriptUrl` and the `firebase` values, then reload. |
| *This email has not been invited* | Admin → Invite that exact email, then register again. |
| *That username is taken* | Usernames are unique (not case-sensitive). Pick another. |
| *Your session has expired* | Sign in again. |
| *`FIREBASE_API_KEY` / `MASTER_FOLDER_ID` is not set* | Add the Script properties (setup step 3). |
| *Drive is not defined* | Enable the Drive service: use the repo's `appsscript.json` (setup step 3.3) or **Services (+) → Drive API → v3**. |
| *The script did not return JSON* | Use the `/exec` URL and set the deployment's access to **Anyone**. |
| *Could not save the file link (403)* | Use the same Google account for Firebase and Apps Script; enable the Cloud Firestore API in the linked Cloud project. |
| *The dates in this file are for 2027, not 2026* | The year you typed must match the dates inside the file. |
| *This does not look like a tracker file* | The workbook needs a Daily Dos / Habits / Products sheet with a row of dates. |
| Changes in `Code.gs` not taking effect | Deploy a **New version** (setup step 3). |
