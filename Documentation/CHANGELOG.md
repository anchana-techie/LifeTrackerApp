# Changelog

Newest first. Add a line here with every feature change.

## 2026-11-09
- **Changed** Astrology: replaced the 7-day Moon timeline with a daily reading for both people. Each gets a Good / Mixed / Careful rating from the Moon (1st/7th/8th from rasi or lagna; Chandrashtamam is always Careful) and Tara balam during waking hours, plus advice. Gocharam of the other planets from the birth rasi (with Sade Sati, Ashtama/Ardhashtama Sani and Guru balam) shapes the advice. The tab also shows today's tithi, nakshatra, sunrise/sunset, Rahu kalam, Yamagandam and Kuligai, and a line for the couple. The Today banner and the 8 am pop-up now show the same reading. Times checked against the Swiss Ephemeris.
- **Added** Astrology: a daily pop-up for linked couples the first time each person opens the app at or after 8 am (once a day per browser, after any admin message or upload pop-up). It lists today's Moon stretches, who is affected and why, a fixed advice line (rotating each day; separate wording for you, your partner, both, or all clear), a Chandrashtamam note when it applies, and the next stretch that is clear for both.
- **Changed** Astrology: the 7-day Moon watch is now one couple timeline showing every Moon stretch, green when clear for both and red when it is the 1st, 7th or 8th from either person's rasi or lagna. The Today banner turns green ("All clear today") on clear days.
- **Added** Astrology for couples (`astro.js`). The admin links two members on the new **Astrology** tab and enters each person's birth date, time and place (city search or coordinates). Only those two people (and the admin) can read the pair: each sees both rasi charts in the South Indian layout (lagna, rasi, nakshatra, planets, Moon today) and a 7-day Moon watch. A banner on Today shows when the moving Moon is in the 1st, 7th or 8th house from either person's rasi or lagna (8th from rasi = Chandrashtamam). Charts are calculated in the browser (Astronomy Engine + Lahiri ayanamsa, checked against the Swiss Ephemeris); no `Code.gs` change. New Firestore collection `astro_pairs`: **paste and publish the updated `firestore.rules`**.

## 2026-11-05
- **Added** Admin Today and Insights show how much each person completed: items ticked today and over 30 days, Daily Dos and Habits separately, perfect days, completion bands and a detail table. Task names stay hidden.
- **Added** The Assistant tab for admins: ask about participants' completion (who is doing best, who has gone quiet, one person's trend) or ask for a completion report. The script picks the admin prompt by role on the server and the tools only return completion statistics, so no personal data is involved. Redeploy `Code.gs`.
- **Added** Admin views and reports also list people who are not in the comparisons: invited but not registered, and registered with no file for the chosen year. They appear as a "Not started yet" card on Today and Insights, in the assistant's data, and as a section in every report. Redeploy `Code.gs` (prompt change).
- **Changed** Admins also see water: daily totals against each person's goal (no drink times). Today and Insights show average intake and days the goal was met (last 30 days and all year), and the assistant and reports can answer whether someone has met their water goal. Everything else personal stays hidden. Redeploy `Code.gs`.
- **Fixed** `group.js` could not load because `pc` was declared in both `app.js` and `group.js`; the assistant code now uses `pci`.
- **Changed** Admin sees completion only. `Code.gs` now answers an admin's `read` of someone else's file with anonymised Daily Do and Habit ticks ("Daily Do 1", "Habit 2") and nothing else, so task names, weight, sleep, water, work, period, spending and files never reach the admin, even from a modified browser. The admin app has no person picker, no per-person view, and no Buy list, Files, Tasks, TimeGenerator or Assistant tabs. Everyone / Combined views drop water, weight, BMI, spending and item names. Redeploy `Code.gs`.
- **Added** Assistant tab: chat with your tracker data (Groq) and ask for a weekly, monthly or yearly report. It asks which period and sections you want if you are vague. Reports show in the chat with figures and charts taken from your real data, and download as PDF (print), HTML or Markdown. The agent loop and data tools run in the browser; `Code.gs` has a new `chat` action that only checks your sign-in, applies a daily limit (80 steps per person, counted in Firestore `chat_usage`) and forwards to Groq. Set script properties `GROQ_API_KEY` (and optionally `GROQ_MODEL`, if unset, the script asks Groq which models your key can use and picks one) and redeploy. Questions and summary statistics (never notes or period data) are sent to Groq.
- **Added** Sleep after midnight: tapping **Sleep** between 12 am and the cutoff (default 4 am, Settings > Late-night sleep, saved in this browser) saves the bedtime to the previous day, so a 12:30 am bedtime on 5 Nov counts for 4 Nov. Sleep totals already handle times across midnight.
- **Added** Tasks tab: add a Daily Do or Habit mid-year with a start date, duration, priority and time of day. It is appended to the Daily Dos / Habits sheet and shows only from its start date (earlier days are hidden and not counted). Existing tasks get the same details. Stored in a new `Task Settings` sheet.
- **Added** TimeGenerator tab: pick a day plus wake and sleep times (a time after midnight is fine). It suggests a time slot for each task by time of day and priority, and an evenly spaced water schedule from your water goal and tumbler, ending two hours before bed.
- **Added** Work location: a Work section on Today with Office (WFO), Home (WFH), Leave and Holiday plus an optional note, stored in a new `Work Log` sheet (Date, Status, Note). Insights has a new Work view: office / home / leave counts, % in office, current run, days per month, office days by weekday, office vs home comparison (list completion and sleep), and weekdays still not logged. Redeploy `Code.gs` (new `setWork` action).
- **Changed** Apps Script has a new action (`saveTask`); redeploy `Code.gs` as a new version.

## 2026-11-03
- **Changed** Marking a Buy list item as bought now ticks the **Products** sheet only if that product is already there. Anything else is a one-time buy: it is recorded in a new `One-time Buys` sheet (Date, Product) and never added to Products or the restock reminders. Redeploy `Code.gs` as a new version.
- **Added** Files tab for members and the admin: pick an uploaded year and read its sheets (Daily Dos, Habits, Products, Period, Weight, Month list, Sleep, Water) as read-only tables, month by month. The admin can open any member's files.
- **Added** Upload > "Create next year's file": starts from the tasks of your latest year, lets you add or remove Daily Dos, Habits and Products, builds the `.xlsx` in the browser (SheetJS from cdnjs) and uploads it as the chosen year, or just downloads it. Daily ticks, weights and sleep start empty; height, water goal and tumbler carry over.
- **Changed** Weight insight uses morning and night weigh-ins: day gain, overnight change, net per day, weekday pattern and item effects.

## 2026-11-02
- **Added** Admin "Everyone" view (default for admins): Today compares everyone's completion, Buy list compares spending by month, Insights combines the whole group. Pick one person to see their own tracker (read-only). The Upload tab is hidden for admins. Code in `group.js`.
- **Changed** Loading now covers the whole screen with a spinner instead of dimming the page.
- **Added** Weight is taken in the morning and at night. Night weight goes in a new `Night Weight (kg)` column of the Weight sheet (created on first save).
- **Added** BMI from your height with WHO bands (under 18.5, 18.5-24.9, 25-29.9, 30+), a healthy weight range, a coloured warning on Today and in Insights, and a night-vs-morning swing in the Weight insight.
- **Added** Water tracker under Body: a body (female or male outline) fills up as you drink. Tap the tumbler button or type any amount in ml; Undo removes the last entry. Stored in a new `Water Log` sheet.
- **Added** Height, daily water goal and tumbler size are asked on first use and editable under Settings > Body & water. Stored in a new `Body Settings` sheet.
- **Changed** Apps Script has new actions (`saveProfile`, `addWater`, `undoWater`); redeploy `Code.gs` as a new version.

## 2026-10-30
- **Added** Documentation folder: architecture diagrams, data model and security, features.
- **Added** Gender at registration (female / male / other). **Male accounts no longer see period tracking or analysis.**
- **Fixed** First upload of a year was refused (rules denied reading a row that did not exist yet). `document_link` reads are now decided by the document id.
- **Added** "Hello, name" greeting at the top left and Sign out at the top right.
- **Added** Accounts: invite-only registration, sign in, change password, forgot password (Firebase Authentication).
- **Added** Upload of yearly `.xlsx` files, converted to Google Sheets at `MasterFolder/<UserName>/<Year>`; link stored in Firestore `document_link`. One upload per user per year.
- **Added** Year picker in the header; only the person's own years are listed.
- **Added** Admin tab and person picker: invite people, view anyone's tracker read-only, remove a wrong upload.
- **Changed** Apps Script no longer takes a passcode or sheet link. It verifies a Firebase token and finds the file itself.
- **Removed** The shared passcode, the "paste your sheet link" box and the Connection settings card.
