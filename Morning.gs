/**
 * Life Tracker: 9 am good-morning notification (a separate file in the same Apps Script project).
 * Uses the helpers in Code.gs (ownerQuery_, fcmRequest_, fsStr_, fsBool_, ownerDelete_).
 * Run setupMorning once to start it. Run morningPush to send one now as a test.
 */

/** Run once: creates the daily trigger at about 9 am India time (Apps Script fires within ~15 minutes). */
function setupMorning() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'morningPush') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('morningPush').timeBased().atHour(9).nearMinute(0).everyDays(1).inTimezone('Asia/Kolkata').create();
  Logger.log('Good-morning notification set for about 9 am every day.');
}

/* ---------- 9 am nudge for everyone with notifications on ---------- */
var MORNING_ = [
  ['Good morning, {name} \u2600\ufe0f', 'Start your day: tick off your first Daily Do in Life Tracker.'],
  ['Rise and track, {name}', 'A quick log now keeps your streak going. Water, habits, mood: tap to start.'],
  ['New day, {name} \ud83c\udf31', 'Plan it in a minute: open Today and pick what you\u2019ll tick off first.'],
  ['Morning check-in, {name}', 'Did you sleep well? Log it, then set up today\u2019s Daily Dos.'],
  ['Hello {name} \ud83d\udc4b', 'Small steps add up. Track one thing right now and keep the momentum.'],
  ['Good morning, {name}', 'First glass of water? Log it in Life Tracker and start the day strong.'],
  ['Today counts, {name} \u2728', 'Open Life Tracker, see your day and start ticking things off.']
];

/** Time trigger, daily at about 9 am India time (created by setupPush). Admins are skipped. */
function morningPush() {
  var rows = ownerQuery_({ from: [{ collectionId: 'push_tokens' }], limit: 500 });
  if (!rows.length) return;
  var members = {};
  ownerQuery_({ from: [{ collectionId: 'members' }], limit: 500 }).forEach(function (m) {
    members[m.name.split('/').pop()] = { name: fsStr_(m, 'userName'), role: fsStr_(m, 'role'), deleted: fsBool_(m, 'deleted') };
  });
  var day = Math.floor((Date.now() + 5.5 * 3600e3) / 864e5), pick = MORNING_[day % MORNING_.length];
  var sends = [], names = [];
  rows.forEach(function (t) {
    var m = members[fsStr_(t, 'uid')];
    if (!m || m.role === 'admin' || m.deleted) return;
    var first = (m.name || 'there').split(/\s+/)[0];
    sends.push(fcmRequest_(fsStr_(t, 'token'), { title: pick[0].replace('{name}', first), body: pick[1], tag: 'morning', url: './?tab=log' }));
    names.push(t.name);
  });
  var ok = 0;
  if (sends.length) UrlFetchApp.fetchAll(sends).forEach(function (res, i) {
    var code = res.getResponseCode(), text = res.getContentText();
    if (code === 200) { ok++; return; }
    if (code === 404 || (code === 400 && /UNREGISTERED|registration token/i.test(text))) { ownerDelete_(names[i]); return; }
    console.warn('Morning push ' + code + ': ' + text.slice(0, 300));
  });
  Logger.log('Morning nudge sent to ' + ok + ' of ' + sends.length + ' phones.');
}
