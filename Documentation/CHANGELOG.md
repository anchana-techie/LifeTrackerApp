# Changelog

Newest first. Add a line here with every feature change.

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
