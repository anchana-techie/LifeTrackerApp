/**
 * Life Tracker bridge — Google Apps Script
 * ------------------------------------------------------------
 * Sits between the GitHub Pages site, Firebase and Google Drive.
 *
 *  - The page sends the signed-in user's Firebase ID token (never a sheet link).
 *  - This script verifies the token, then reads Firestore *as that user*, so the
 *    Firestore security rules decide who may see which year file.
 *  - Only this script writes document_link rows (as the project owner); browsers cannot.
 *  - Uploaded .xlsx files are converted to Google Sheets inside
 *      MASTER_FOLDER / <UserName> / <Year>
 *    and the file id + link are written to Firestore (collection document_link).
 *
 * Script properties (Project Settings -> Script properties):
 *   MASTER_FOLDER_ID     id of the Drive folder that holds one sub-folder per user
 *   FIREBASE_PROJECT_ID  Firebase project id
 *   FIREBASE_API_KEY     Firebase web API key (same one as in config.js)
 *
 * Needs the Advanced Drive service (Services -> Drive API, v3). See README.
 */

var BUY_SETTINGS = 'Buy Settings';
var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
var XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
var MAX_UPLOAD_B64 = 14000000;   // ~10 MB of file

// ---------- entry points ----------

function doGet() {
  return json_({ ok: true, message: 'Tracker bridge is running. Use the website to talk to it.' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Bad request body.' });
  }

  try {
    var auth = authenticate_(req.idToken);
    if (req.action === 'ping') return json_({ ok: true, data: { uid: auth.uid } });

    // An upload only creates a brand-new file, so it skips the lock: it takes the longest by far
    // and would otherwise make every other request (and the next upload) wait behind it.
    if (req.action === 'upload') return json_({ ok: true, data: upload_(auth, req) });

    // the assistant only talks to Groq; it never opens the user's sheet, so it needs no file lookup or lock
    if (req.action === 'chat') return json_({ ok: true, data: chat_(auth, req) });

    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var result;
      {
        var target = resolveFile_(auth, req);
        if (target.readOnly && req.action !== 'read') throw new Error('This is a read-only view.');
        var ss = SpreadsheetApp.openById(target.fileId);
        switch (req.action) {
          case 'read':         result = readAll_(ss); break;
          case 'saveDay':      result = saveDay_(ss, req); break;
          case 'saveDays':     result = saveDays_(ss, req); break;
          case 'saveBuyList':  result = saveBuyList_(ss, req); break;
          case 'markBought':   result = markBought_(ss, req); break;
          case 'saveProfile':  result = saveProfile_(ss, req); break;
          case 'addWater':     result = addWater_(ss, req); break;
          case 'undoWater':    result = undoWater_(ss, req); break;
          case 'setSleep':     result = setSleep_(ss, req); break;
          case 'saveTask':     result = saveTask_(ss, req); break;
          case 'setWork':      result = setWork_(ss, req); break;
          default: throw new Error('Unknown action: ' + req.action);
        }
        SpreadsheetApp.flush();
      }
      return json_({ ok: true, data: result });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// ---------- helpers ----------

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function prop_(name) {
  var v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v) throw new Error(name + ' is not set in Script properties.');
  return v;
}

// ---------- Firebase: sign-in check + Firestore (as the signed-in user) ----------

/** Verifies the Firebase ID token with Google and returns { uid, token }. */
function authenticate_(token) {
  token = String(token || '');
  if (!token) throw new Error('Please sign in.');
  var cache = CacheService.getScriptCache();
  var key = 'a_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  var uid = cache.get(key);
  if (!uid) {
    var res = UrlFetchApp.fetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(prop_('FIREBASE_API_KEY')), {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify({ idToken: token }), muteHttpExceptions: true
      });
    var body = JSON.parse(res.getContentText() || '{}');
    if (res.getResponseCode() !== 200 || !body.users || !body.users.length) {
      throw new Error('Your session has expired. Please sign in again.');
    }
    uid = body.users[0].localId;
    cache.put(key, uid, 300);
  }
  return { uid: uid, token: token };
}

function fsBase_() {
  return 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(prop_('FIREBASE_PROJECT_ID')) +
    '/databases/(default)/documents/';
}

/** GET a Firestore document with the user's own token, so security rules apply. null when missing. */
function fsGet_(path, token) {
  var res = UrlFetchApp.fetch(fsBase_() + path, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  var code = res.getResponseCode();
  if (code === 404) return null;
  if (code === 401 || code === 403) throw new Error('You do not have access to that.');
  if (code !== 200) throw new Error('Database error (' + code + ').');
  return JSON.parse(res.getContentText());
}

/** Several fsGet_ calls in parallel. A null path gives a null slot; results line up with the input. */
function fsGetMany_(paths, token) {
  var reqs = [], idx = [];
  paths.forEach(function (p, i) {
    if (!p) return;
    reqs.push({ url: fsBase_() + p, headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    idx.push(i);
  });
  var out = paths.map(function () { return null; });
  UrlFetchApp.fetchAll(reqs).forEach(function (res, k) {
    var code = res.getResponseCode();
    if (code === 404) return;
    if (code === 401 || code === 403) throw new Error('You do not have access to that.');
    if (code !== 200) throw new Error('Database error (' + code + ').');
    out[idx[k]] = JSON.parse(res.getContentText());
  });
  return out;
}

/**
 * Creates a document as the script owner (project owner access, which bypasses the security rules).
 * Only this script may write document_link rows — browsers cannot — so nobody can point their row at
 * someone else's file. Fails if the id already exists, which is what blocks re-uploading a year.
 */
function fsCreate_(collection, docId, fields) {
  var res = UrlFetchApp.fetch(fsBase_() + collection + '?documentId=' + encodeURIComponent(docId), {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Goog-User-Project': prop_('FIREBASE_PROJECT_ID') },
    payload: JSON.stringify({ fields: fields }), muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code === 409) throw new Error('That year has already been uploaded.');
  if (code !== 200) throw new Error('Could not save the file link (' + code + '). Check the setup steps in the README.');
}

/** Creates or overwrites a document as the script owner. */
function fsSet_(path, fields) {
  var res = UrlFetchApp.fetch(fsBase_() + path, {
    method: 'patch', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Goog-User-Project': prop_('FIREBASE_PROJECT_ID') },
    payload: JSON.stringify({ fields: fields }), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('Could not save (' + res.getResponseCode() + ').');
}

/** Deletes a document as the script owner. Used to clear a link whose Drive file no longer exists. */
function fsDelete_(path) {
  UrlFetchApp.fetch(fsBase_() + path, {
    method: 'delete',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Goog-User-Project': prop_('FIREBASE_PROJECT_ID') },
    muteHttpExceptions: true
  });
}

/** True when the Drive file behind a document_link row is gone (deleted or in the bin). */
function linkIsStale_(doc) {
  var id = fsStr_(doc, 'driveFileId');
  if (!id) return true;
  try { return DriveApp.getFileById(id).isTrashed(); } catch (err) { return true; }
}

function fsStr_(doc, name) {
  var f = doc && doc.fields && doc.fields[name];
  return f && f.stringValue !== undefined ? f.stringValue : '';
}

function getMember_(auth) {
  var doc = fsGet_('members/' + auth.uid, auth.token);
  if (!doc) throw new Error('Your account is not set up. Please sign out and register again.');
  return { userName: fsStr_(doc, 'userName'), role: fsStr_(doc, 'role') };
}

function parseYear_(v) {
  var y = Number(v);
  if (!isFinite(y) || y !== Math.floor(y) || y < 2000 || y > 2100) throw new Error('Choose a valid year.');
  return y;
}

/**
 * Finds the Drive file for the request. Own file by default; an admin may pass asUid
 * to look at someone else's file (read-only). The link is read from Firestore with the
 * caller's token, so the rules — not this code — are the final gate.
 */
function resolveFile_(auth, req) {
  var year = parseYear_(req.year);
  var target = auth.uid, readOnly = false;
  if (req.asUid && String(req.asUid) !== auth.uid) {
    if (getMember_(auth).role !== 'admin') throw new Error('You do not have access to that.');
    target = String(req.asUid);
    if (!/^[A-Za-z0-9]{10,40}$/.test(target)) throw new Error('Bad user.');
    readOnly = true;
  }
  var doc = fsGet_('document_link/' + target + '_' + year, auth.token);
  if (!doc) throw new Error('No file has been uploaded for ' + year + '.');
  var fileId = fsStr_(doc, 'driveFileId');
  if (!fileId) throw new Error('The file link is incomplete.');
  return { fileId: fileId, readOnly: readOnly };
}

// ---------- assistant: a thin, authenticated proxy to Groq (OpenAI-compatible API) ----------
// The browser runs the data tools and the agent loop; this only hides the API key,
// checks who is asking, enforces a daily limit and fixes the system prompt.

var GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
var GROQ_DEFAULT_MODEL = 'llama-3.3-70b-versatile';   // override with the GROQ_MODEL script property
var CHAT_DAILY_CAP = 80;             // Groq calls per person per day (one chat turn can use several)
var CHAT_MAX_MESSAGES = 40;
var CHAT_MAX_CONTENT = 20000;

/** Counts one call in Firestore (chat_usage/<uid>_<yyyyMMdd>, owner access only) and refuses past the cap. */
function chatUsageBump_(uid) {
  var id = uid + '_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');
  var headers = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Goog-User-Project': prop_('FIREBASE_PROJECT_ID') };
  var res = UrlFetchApp.fetch(fsBase_() + 'chat_usage/' + encodeURIComponent(id), { headers: headers, muteHttpExceptions: true });
  var n = 0, code = res.getResponseCode();
  if (code === 200) {
    var f = JSON.parse(res.getContentText()).fields;
    n = Number(f && f.count && f.count.integerValue || 0);
  } else if (code !== 404) {
    throw new Error('Could not check the daily assistant limit.');
  }
  if (n >= CHAT_DAILY_CAP) throw new Error('You have reached the daily assistant limit (' + CHAT_DAILY_CAP + ' steps). Please try again tomorrow.');
  fsSet_('chat_usage/' + id, { userId: { stringValue: uid }, count: { integerValue: String(n + 1) } });
}

/** Keeps only well-formed user / assistant / tool messages; the system prompt is never taken from the browser. */
function chatClean_(messages) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('Nothing to send.');
  if (messages.length > CHAT_MAX_MESSAGES) throw new Error('This chat is too long. Start a new chat.');
  return messages.map(function (m) {
    var role = m && m.role;
    var content = String(m && m.content != null ? m.content : '').slice(0, CHAT_MAX_CONTENT);
    if (role === 'user') return { role: 'user', content: content };
    if (role === 'tool') return { role: 'tool', tool_call_id: String(m.tool_call_id || '').slice(0, 100), content: content };
    if (role === 'assistant') {
      var out = { role: 'assistant', content: content };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        out.tool_calls = m.tool_calls.slice(0, 8).map(function (t) {
          return { id: String(t.id || '').slice(0, 100), type: 'function',
            function: { name: String(t.function && t.function.name || '').slice(0, 64), arguments: String(t.function && t.function.arguments || '{}').slice(0, 8000) } };
        });
      }
      return out;
    }
    throw new Error('Bad message.');
  });
}

function chatTools_(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.slice(0, 10).filter(function (t) { return t && t.type === 'function' && t.function && /^[a-z_]{1,40}$/.test(String(t.function.name)); })
    .map(function (t) {
      return { type: 'function', function: { name: t.function.name, description: String(t.function.description || '').slice(0, 600), parameters: t.function.parameters || { type: 'object', properties: {} } } };
    });
}

function chatSystem_(ctx) {
  var d = /^\d{4}-\d{2}-\d{2}$/;
  ctx = ctx || {};
  var today = d.test(String(ctx.today)) ? ctx.today : '', first = d.test(String(ctx.first)) ? ctx.first : '', last = d.test(String(ctx.last)) ? ctx.last : '';
  return [
    'You are the assistant inside Life Tracker, a personal habit and health tracker. You help one person understand their own data.',
    'Today is ' + today + '. The open tracker covers ' + first + ' to ' + last + '. All dates are YYYY-MM-DD. Weeks run Monday to Sunday.',
    'Rules:',
    '- Get every number from the tools. Never invent, guess or estimate numbers. If data is missing, say so plainly.',
    '- Be concise and friendly. Short paragraphs or bullets, plain language, no tables.',
    '- You are not a doctor. Describe patterns and associations, not diagnoses, and suggest a professional for medical worries.',
    '- Available data: Daily Dos (dos), Habits (habits), sleep, weight, water, work location (work: office/home/leave/holiday) and spending (spending). Period tracking is not available to you.',
    'Reports:',
    '- When the user asks for a report, do NOT build it straight away unless they already gave BOTH a period (a week, a month, a year or exact dates) AND what to include.',
    '- Otherwise ask one short question offering: the period (this week, last week, this month, last month, the whole year, or exact dates) and the sections (Daily Dos, Habits, Sleep, Water, Weight, Work location, Spending; all by default).',
    '- Then resolve the period to exact dates, call get_report_data once, write the narrative, and call publish_report once.',
    '- For each section write 2 to 5 short sentences or bullets using only numbers from get_report_data, plus one practical suggestion where the data supports it.',
    '- After publish_report succeeds, reply with one or two sentences and do not repeat the report.'
  ].join('\n');
}

/** req: { messages, tools, context:{today,first,last} } -> { message } */
function chat_(auth, req) {
  if (req.asUid && String(req.asUid) !== auth.uid) throw new Error('The assistant is only available on your own tracker.');
  var key = prop_('GROQ_API_KEY');
  var messages = chatClean_(req.messages), tools = chatTools_(req.tools);
  chatUsageBump_(auth.uid);
  var model = PropertiesService.getScriptProperties().getProperty('GROQ_MODEL') || GROQ_DEFAULT_MODEL;
  var body = { model: model, messages: [{ role: 'system', content: chatSystem_(req.context) }].concat(messages), temperature: 0.3, max_tokens: 2500 };
  if (tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
  var res = UrlFetchApp.fetch(GROQ_URL, {
    method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code === 401 || code === 403) throw new Error('The assistant is not set up correctly (check the API key).');
  if (code === 429) throw new Error('The assistant is busy. Please try again in a moment.');
  if (code !== 200) throw new Error('The assistant could not answer (' + code + ').');
  var j = JSON.parse(res.getContentText() || '{}');
  var m = j.choices && j.choices[0] && j.choices[0].message;
  if (!m) throw new Error('The assistant returned nothing. Please try again.');
  var out = { role: 'assistant', content: m.content || '' };
  if (m.tool_calls && m.tool_calls.length) out.tool_calls = m.tool_calls;
  return { message: out };
}

// ---------- upload: xlsx -> Google Sheet in MASTER / UserName ----------

function userFolder_(userName) {
  var master = DriveApp.getFolderById(prop_('MASTER_FOLDER_ID'));
  var it = master.getFoldersByName(userName);
  return it.hasNext() ? it.next() : master.createFolder(userName);
}

function detectYear_(ss) {
  var tz = ss.getSpreadsheetTimeZone();
  var keys = ['dos', 'habits', 'products'];
  for (var i = 0; i < keys.length; i++) {
    var sh = findSheet_(ss, SHEETS[keys[i]]);
    if (!sh) continue;
    try {
      var g = parseGrid_(sh, tz);
      if (g.dates.length) return Number(g.dates[0].slice(0, 4));
    } catch (err) { /* try the next sheet */ }
  }
  throw new Error('This does not look like a tracker file (no Daily Dos / Habits / Products sheet with dates).');
}

/** req: { year, data: base64 of the .xlsx, asUid? } — asUid lets an admin upload on someone's behalf */
function upload_(auth, req) {
  var year = parseYear_(req.year);
  var asOther = !!req.asUid && String(req.asUid) !== auth.uid;
  var targetUid = asOther ? String(req.asUid) : auth.uid, uploadedBy = '';
  if (asOther && !/^[A-Za-z0-9]{10,40}$/.test(targetUid)) throw new Error('Bad user.');
  var linkId = targetUid + '_' + year;

  // the three lookups are independent, so fetch them together instead of one after another
  var docs = fsGetMany_(['members/' + auth.uid, asOther ? 'members/' + targetUid : null, 'document_link/' + linkId], auth.token);
  if (!docs[0]) throw new Error('Your account is not set up. Please sign out and register again.');
  var member = { userName: fsStr_(docs[0], 'userName'), role: fsStr_(docs[0], 'role') };
  if (asOther) {
    if (member.role !== 'admin') throw new Error('You do not have access to that.');
    if (!docs[1]) throw new Error('That person was not found.');
    uploadedBy = member.userName;
    member = { userName: fsStr_(docs[1], 'userName'), role: fsStr_(docs[1], 'role') };
  } else if (member.role === 'admin') {
    throw new Error('Choose the person to upload for.');   // admins do not keep a tracker of their own
  }
  var existing = docs[2];
  if (existing) {
    if (!linkIsStale_(existing)) throw new Error(year + ' has already been uploaded and cannot be replaced.');
    fsDelete_('document_link/' + linkId);   // the Drive file was deleted, so free the year up again
  }

  var b64 = String(req.data || '');
  if (!b64) throw new Error('No file received.');
  if (b64.length > MAX_UPLOAD_B64) throw new Error('That file is too large (limit about 10 MB).');
  var bytes = Utilities.base64Decode(b64);
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4B) throw new Error('Please upload an Excel .xlsx file.');

  var folder = userFolder_(member.userName);
  // a removed year leaves its old sheet behind; bin it so the new upload replaces it rather than sitting beside it
  var stale = folder.getFilesByName(String(year));
  while (stale.hasNext()) {
    var f = stale.next();
    if (f.getMimeType() === 'application/vnd.google-apps.spreadsheet') f.setTrashed(true);
  }
  var blob = Utilities.newBlob(bytes, XLSX_MIME, String(year) + '.xlsx');
  var created = Drive.Files.create({
    name: String(year), mimeType: 'application/vnd.google-apps.spreadsheet', parents: [folder.getId()]
  }, blob);

  try {
    var detected = detectYear_(SpreadsheetApp.openById(created.id));
    if (detected !== year) throw new Error('The dates in this file are for ' + detected + ', not ' + year + '.');
    var link = 'https://docs.google.com/spreadsheets/d/' + created.id + '/edit';
    var fields = {
      userId: { stringValue: targetUid },
      userName: { stringValue: member.userName },
      year: { integerValue: String(year) },
      driveFileId: { stringValue: created.id },
      driveLink: { stringValue: link },
      uploadedAt: { timestampValue: new Date().toISOString() }
    };
    fsCreate_('document_link', linkId, fields);
    var noticeError = '';
    if (uploadedBy) {
      // the member sees this once at next sign-in, then the app deletes it; a failure here must not undo the upload
      try {
        fsSet_('notices/' + linkId, {
          userId: { stringValue: targetUid },
          year: { integerValue: String(year) },
          by: { stringValue: uploadedBy },
          createdAt: { timestampValue: new Date().toISOString() }
        });
      } catch (err) { noticeError = String(err.message || err); }
    }
    return { year: year, link: link, noticeError: noticeError };
  } catch (err) {
    DriveApp.getFileById(created.id).setTrashed(true);   // do not leave an orphan file behind
    throw err;
  }
}

function findSheet_(ss, regex) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (regex.test(sheets[i].getName().trim())) return sheets[i];
  }
  return null;
}

var SHEETS = {
  products: /^products/i,
  dos: /^daily\s*dos/i,
  habits: /^habit/i,
  period: /^period/i,
  weight: /^weight/i,
  buy: /^month\s*list/i
};

function norm_(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

function isX_(v) {
  return String(v == null ? '' : v).trim().toUpperCase() === 'X';
}

function fmt_(d, tz) {
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

// ---------- grid sheets (Products / Daily Dos / Habits) ----------

var HEADER_LABELS = ['products', 'product', 'dos', 'habits', 'habit', 'items'];

function parseGrid_(sh, tz) {
  var values = sh.getDataRange().getValues();
  var dateRow = -1, best = 0;
  for (var r = 0; r < Math.min(10, values.length); r++) {
    var n = 0;
    for (var c = 0; c < values[r].length; c++) if (isDate_(values[r][c])) n++;
    if (n > best) { best = n; dateRow = r; }
  }
  if (dateRow < 0) throw new Error('No date row found in "' + sh.getName() + '".');

  var dateCols = {}, dates = [];
  for (var c2 = 0; c2 < values[dateRow].length; c2++) {
    var v = values[dateRow][c2];
    if (isDate_(v)) { var k = fmt_(v, tz); dateCols[k] = c2; dates.push(k); }
  }

  var items = [];
  for (var r2 = dateRow + 1; r2 < values.length; r2++) {
    var name = String(values[r2][0] == null ? '' : values[r2][0]).trim();
    if (!name) continue;
    if (HEADER_LABELS.indexOf(norm_(name)) >= 0) continue;
    var marked = [];
    for (var i = 0; i < dates.length; i++) {
      if (isX_(values[r2][dateCols[dates[i]]])) marked.push(dates[i]);
    }
    items.push({ name: name, row: r2, marked: marked });
  }
  return { sheet: sh, dateRow: dateRow, dateCols: dateCols, dates: dates, items: items };
}

function gridToJson_(g) {
  return {
    sheetName: g.sheet.getName(),
    dates: g.dates,
    items: g.items.map(function (it) { return { name: it.name, marked: it.marked }; })
  };
}

function setGridMark_(g, itemName, date, on, allowAppend) {
  var col = g.dateCols[date];
  if (col === undefined) throw new Error(date + ' is not a column in "' + g.sheet.getName() + '".');
  var item = null;
  for (var i = 0; i < g.items.length; i++) {
    if (norm_(g.items[i].name) === norm_(itemName)) { item = g.items[i]; break; }
  }
  if (!item) {
    if (!on) return;
    if (!allowAppend) throw new Error('"' + itemName + '" is not in "' + g.sheet.getName() + '".');
    var last = g.items.length ? g.items[g.items.length - 1].row : g.dateRow + 1;
    g.sheet.insertRowAfter(last + 1);           // 1-based: row after the last item
    g.sheet.getRange(last + 2, 1).setValue(itemName.trim());
    item = { name: itemName.trim(), row: last + 1, marked: [] };
    g.items.push(item);
  }
  g.sheet.getRange(item.row + 1, col + 1).setValue(on ? 'X' : '');
}

// ---------- period calendar ----------

function parsePeriod_(sh, tz) {
  var values = sh.getDataRange().getValues();
  var cells = {}, dates = [], marked = [];
  // the data range can end on the last date row when its mark row is still empty,
  // so the row below may not exist in `values` — treat it as blank
  for (var r = 0; r < values.length; r++) {
    for (var c = 0; c < values[r].length; c++) {
      var v = values[r][c];
      if (isDate_(v)) {
        var k = fmt_(v, tz);
        cells[k] = { row: r + 1, col: c };      // mark cell sits directly under the date
        dates.push(k);
        if (r + 1 < values.length && isX_(values[r + 1][c])) marked.push(k);
      }
    }
  }
  dates.sort(); marked.sort();
  return { sheet: sh, cells: cells, dates: dates, marked: marked };
}

// ---------- weight ----------

function parseWeight_(sh, tz) {
  var values = sh.getDataRange().getValues();
  var hRow = -1, dCol = -1, wCol = -1, nCol = -1;
  for (var r = 0; r < Math.min(10, values.length) && hRow < 0; r++) {
    for (var c = 0; c < values[r].length; c++) {
      var t = norm_(values[r][c]);
      if (t.indexOf('weight') === 0) wCol = c;
      if (t.indexOf('night') === 0) nCol = c;
      if (t === 'date') dCol = c;
    }
    if (wCol >= 0 && dCol >= 0) hRow = r;
  }
  if (hRow < 0) throw new Error('Could not find the Date / Weight header in "' + sh.getName() + '".');
  var rows = {}, dates = [], entries = {}, night = {};
  for (var r2 = hRow + 1; r2 < values.length; r2++) {
    var d = values[r2][dCol];
    if (!isDate_(d)) continue;
    var k = fmt_(d, tz);
    rows[k] = r2; dates.push(k);
    var w = values[r2][wCol];
    if (w !== '' && w !== null && !isNaN(Number(w))) entries[k] = Number(w);
    if (nCol >= 0) {
      var nw = values[r2][nCol];
      if (nw !== '' && nw !== null && !isNaN(Number(nw))) night[k] = Number(nw);
    }
  }
  return { sheet: sh, hRow: hRow, rows: rows, wCol: wCol, nCol: nCol, dates: dates, entries: entries, night: night };
}

/** Morning weight lives in the original Weight column; night weight gets its own column, added on first use. */
function ensureNightCol_(w) {
  if (w.nCol >= 0) return w.nCol;
  var col = w.sheet.getLastColumn() + 1;
  var head = w.sheet.getRange(w.hRow + 1, col);
  head.setValue('Night Weight (kg)');
  w.sheet.getRange(w.hRow + 1, w.wCol + 1).copyTo(head, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  w.nCol = col - 1;
  return w.nCol;
}

function weightCell_(v) {
  if (v === '' || v === null) return '';
  var n = Number(v);
  if (isNaN(n) || n <= 0 || n > 400) throw new Error('Weight looks wrong: ' + v);
  return n;
}

// ---------- body settings (height, water goal, tumbler) ----------

var BODY_SETTINGS = 'Body Settings';
var PROFILE_KEYS = { height: 'Height (cm)', waterGoal: 'Water goal (ml)', tumbler: 'Tumbler (ml)' };

function readProfile_(ss) {
  var out = { height: null, waterGoal: null, tumbler: null };
  var sh = ss.getSheetByName(BODY_SETTINGS);
  if (!sh) return out;
  var values = sh.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    var label = norm_(values[r][0]);
    Object.keys(PROFILE_KEYS).forEach(function (k) {
      var v = values[r][1];
      if (label === norm_(PROFILE_KEYS[k]) && v !== '' && !isNaN(Number(v))) out[k] = Number(v);
    });
  }
  return out;
}

/** req: { height: cm, waterGoal: ml, tumbler: ml } */
function saveProfile_(ss, req) {
  var h = Number(req.height), g = Number(req.waterGoal), t = Number(req.tumbler);
  if (!(h >= 80 && h <= 250)) throw new Error('Height should be between 80 and 250 cm.');
  if (!(g >= 500 && g <= 10000)) throw new Error('Water goal should be between 500 and 10000 ml.');
  if (!(t >= 50 && t <= 3000)) throw new Error('Tumbler size should be between 50 and 3000 ml.');
  var sh = ss.getSheetByName(BODY_SETTINGS);
  if (!sh) {
    sh = ss.insertSheet(BODY_SETTINGS);
    sh.getRange(1, 1, 1, 2).setValues([['Setting', 'Value']])
      .setFontWeight('bold').setFontColor('#ffffff').setBackground('#2F5496');
    sh.setColumnWidth(1, 160); sh.setColumnWidth(2, 110); sh.setFrozenRows(1);
  }
  sh.getRange(2, 1, 3, 2).setValues([
    [PROFILE_KEYS.height, Math.round(h * 10) / 10],
    [PROFILE_KEYS.waterGoal, Math.round(g)],
    [PROFILE_KEYS.tumbler, Math.round(t)]
  ]);
  return { saved: true };
}

// ---------- water log: Date | Goal (ml) | Total (ml) | Log ----------

var WATER_SHEET = 'Water Log';
var WATER_SEP = ' | ';

function parseWaterLog_(text) {
  var out = [];
  String(text || '').split(WATER_SEP).forEach(function (part) {
    var m = part.trim().match(/^(\d{2}:\d{2}) \+(\d+)$/);
    if (m) out.push({ t: m[1], ml: Number(m[2]) });
  });
  return out;
}

function waterLogText_(log) {
  return log.map(function (e) { return e.t + ' +' + e.ml; }).join(WATER_SEP);
}

function waterDateKey_(v, tz) {
  return isDate_(v) ? fmt_(v, tz) : String(v == null ? '' : v).trim();
}

function readWater_(ss, tz) {
  var out = { days: {} };
  var sh = ss.getSheetByName(WATER_SHEET);
  if (!sh) return out;
  var values = sh.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    var k = waterDateKey_(values[r][0], tz);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    var total = Number(values[r][2]);
    out.days[k] = { goal: Number(values[r][1]) || null, total: isNaN(total) ? 0 : total, log: parseWaterLog_(values[r][3]) };
  }
  return out;
}

function getWaterSheet_(ss) {
  var sh = ss.getSheetByName(WATER_SHEET);
  if (!sh) {
    sh = ss.insertSheet(WATER_SHEET);
    sh.getRange(1, 1, 1, 4).setValues([['Date', 'Goal (ml)', 'Total (ml)', 'Log']])
      .setFontWeight('bold').setFontColor('#ffffff').setBackground('#2F5496');
    sh.getRange('A:A').setNumberFormat('@');
    sh.getRange('B:C').setNumberFormat('#,##0');
    sh.setColumnWidth(1, 100); sh.setColumnWidth(2, 90); sh.setColumnWidth(3, 90); sh.setColumnWidth(4, 420);
    sh.setFrozenRows(1);
  }
  return sh;
}

function waterRow_(sh, date, tz, create) {
  var values = sh.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    if (waterDateKey_(values[r][0], tz) === date) return { row: r + 1, log: parseWaterLog_(values[r][3]) };
  }
  if (!create) return null;
  return { row: Math.max(sh.getLastRow(), 1) + 1, log: [] };
}

function writeWater_(sh, row, date, goal, log) {
  var total = log.reduce(function (s, e) { return s + e.ml; }, 0);
  sh.getRange(row, 1).setNumberFormat('@').setValue(date);
  sh.getRange(row, 2, 1, 3).setValues([[goal || '', total, waterLogText_(log)]]);
  return { total: total, goal: goal || null, log: log };
}

/** req: { date, ml, time:'HH:mm' } */
function addWater_(ss, req) {
  var tz = ss.getSpreadsheetTimeZone();
  var date = String(req.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date.');
  var ml = Math.round(Number(req.ml));
  if (!(ml >= 1 && ml <= 3000)) throw new Error('Enter between 1 and 3000 ml.');
  var time = /^\d{2}:\d{2}$/.test(String(req.time || '')) ? req.time : Utilities.formatDate(new Date(), tz, 'HH:mm');
  var sh = getWaterSheet_(ss);
  var r = waterRow_(sh, date, tz, true);
  r.log.push({ t: time, ml: ml });
  return writeWater_(sh, r.row, date, readProfile_(ss).waterGoal, r.log);
}

/** req: { date } — removes the most recent entry of that day */
function undoWater_(ss, req) {
  var tz = ss.getSpreadsheetTimeZone();
  var date = String(req.date || '');
  var sh = ss.getSheetByName(WATER_SHEET);
  var r = sh && waterRow_(sh, date, tz, false);
  if (!r || !r.log.length) return { total: 0, goal: null, log: [] };
  r.log.pop();
  return writeWater_(sh, r.row, date, readProfile_(ss).waterGoal, r.log);
}

// ---------- sleep log: Date | Wake up | Sleep (HH:mm text) ----------

var SLEEP_SHEET = 'Sleep Log';

function timeText_(v, tz) {
  if (isDate_(v)) return Utilities.formatDate(v, tz, 'HH:mm');
  var s = String(v == null ? '' : v).trim();
  return /^\d{1,2}:\d{2}$/.test(s) ? (s.length === 4 ? '0' + s : s) : '';
}

function readSleep_(ss, tz) {
  var out = { days: {} };
  var sh = ss.getSheetByName(SLEEP_SHEET);
  if (!sh) return out;
  var values = sh.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    var k = waterDateKey_(values[r][0], tz);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    out.days[k] = { wake: timeText_(values[r][1], tz), sleep: timeText_(values[r][2], tz) };
  }
  return out;
}

/** req: { date, kind:'wake'|'sleep', time:'HH:mm' | '' (clears it) } */
function setSleep_(ss, req) {
  var tz = ss.getSpreadsheetTimeZone();
  var date = String(req.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date.');
  if (req.kind !== 'wake' && req.kind !== 'sleep') throw new Error('Unknown sleep entry.');
  var time = String(req.time == null ? '' : req.time);
  if (time !== '' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Invalid time.');

  var sh = ss.getSheetByName(SLEEP_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SLEEP_SHEET);
    sh.getRange(1, 1, 1, 3).setValues([['Date', 'Wake up', 'Sleep']])
      .setFontWeight('bold').setFontColor('#ffffff').setBackground('#2F5496');
    sh.getRange('A:C').setNumberFormat('@');
    sh.setColumnWidth(1, 100); sh.setColumnWidth(2, 90); sh.setColumnWidth(3, 90);
    sh.setFrozenRows(1);
  }
  var values = sh.getDataRange().getValues(), row = -1;
  for (var r = 1; r < values.length; r++) {
    if (waterDateKey_(values[r][0], tz) === date) { row = r + 1; break; }
  }
  if (row < 0) {
    row = Math.max(sh.getLastRow(), 1) + 1;
    sh.getRange(row, 1).setNumberFormat('@').setValue(date);
  }
  sh.getRange(row, req.kind === 'wake' ? 2 : 3).setNumberFormat('@').setValue(time);
  return { saved: true };
}

// ---------- work location log: Date | Status | Note ----------

var WORK_SHEET = 'Work Log';
var WORK_STATUSES = ['WFO', 'WFH', 'Leave', 'Holiday'];

function readWork_(ss, tz) {
  var out = { days: {} };
  var sh = ss.getSheetByName(WORK_SHEET);
  if (!sh) return out;
  var values = sh.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    var k = waterDateKey_(values[r][0], tz);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    var st = String(values[r][1] == null ? '' : values[r][1]).trim();
    out.days[k] = { status: WORK_STATUSES.indexOf(st) >= 0 ? st : '', note: String(values[r][2] == null ? '' : values[r][2]) };
  }
  return out;
}

/** req: { date, status:'WFO'|'WFH'|'Leave'|'Holiday'|'' (clears it), note } */
function setWork_(ss, req) {
  var tz = ss.getSpreadsheetTimeZone();
  var date = String(req.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date.');
  var status = String(req.status || '');
  if (status !== '' && WORK_STATUSES.indexOf(status) < 0) throw new Error('Unknown work status.');
  var note = String(req.note == null ? '' : req.note).trim().slice(0, 200);

  var sh = ss.getSheetByName(WORK_SHEET);
  if (!sh) {
    sh = ss.insertSheet(WORK_SHEET);
    sh.getRange(1, 1, 1, 3).setValues([['Date', 'Status', 'Note']])
      .setFontWeight('bold').setFontColor('#ffffff').setBackground('#2F5496');
    sh.getRange('A:C').setNumberFormat('@');
    sh.setColumnWidth(1, 100); sh.setColumnWidth(2, 90); sh.setColumnWidth(3, 300);
    sh.setFrozenRows(1);
  }
  var values = sh.getDataRange().getValues(), row = -1;
  for (var r = 1; r < values.length; r++) {
    if (waterDateKey_(values[r][0], tz) === date) { row = r + 1; break; }
  }
  if (row < 0) {
    if (status === '' && note === '') return { saved: true };
    row = Math.max(sh.getLastRow(), 1) + 1;
    sh.getRange(row, 1).setNumberFormat('@').setValue(date);
  }
  sh.getRange(row, 2, 1, 2).setNumberFormat('@').setValues([[status, note]]);
  return { saved: true };
}

// ---------- task settings: Task | List | Start date | Duration (min) | Priority | Period ----------

var TASK_SHEET = 'Task Settings';
var TASK_PERIODS = ['Morning', 'Daytime', 'Evening'];

function readTasks_(ss, tz) {
  var out = {};
  var sh = ss.getSheetByName(TASK_SHEET);
  if (!sh) return out;
  var values = sh.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    var name = String(values[r][0] == null ? '' : values[r][0]).trim();
    if (!name) continue;
    var start = isDate_(values[r][2]) ? fmt_(values[r][2], tz) : String(values[r][2] || '').trim();
    out[name] = {
      kind: norm_(values[r][1]) === 'habits' ? 'habits' : 'dos',
      start: /^\d{4}-\d{2}-\d{2}$/.test(start) ? start : '',
      duration: Number(values[r][3]) > 0 ? Number(values[r][3]) : null,
      priority: Number(values[r][4]) >= 1 && Number(values[r][4]) <= 3 ? Number(values[r][4]) : 2,
      period: TASK_PERIODS.indexOf(String(values[r][5])) >= 0 ? String(values[r][5]) : ''
    };
  }
  return out;
}

/**
 * req: { name, kind:'dos'|'habits', create:true|false, start:'yyyy-MM-dd'|'', duration:min|null,
 *        priority:1|2|3 (1 = high), period:'Morning'|'Daytime'|'Evening'|'' }
 * create adds the task as a new row in Daily Dos / Habits (it must not exist yet); otherwise only its settings change.
 */
function saveTask_(ss, req) {
  var tz = ss.getSpreadsheetTimeZone();
  var name = String(req.name || '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 80) throw new Error('Task name is required (80 characters at most).');
  var kind = req.kind === 'habits' ? 'habits' : 'dos';
  var start = String(req.start || '');
  if (start !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error('Invalid start date.');
  var duration = req.duration === null || req.duration === '' || req.duration === undefined ? '' : Number(req.duration);
  if (duration !== '' && !(duration >= 1 && duration <= 720)) throw new Error('Duration should be between 1 and 720 minutes.');
  var priority = Number(req.priority || 2);
  if (!(priority >= 1 && priority <= 3)) throw new Error('Priority should be 1, 2 or 3.');
  var period = String(req.period || '');
  if (period !== '' && TASK_PERIODS.indexOf(period) < 0) throw new Error('Unknown period.');

  var found = null;
  ['dos', 'habits', 'products'].forEach(function (k) {
    var sh = findSheet_(ss, SHEETS[k]);
    if (!sh) return;
    var g = parseGrid_(sh, tz);
    g.items.forEach(function (it) { if (norm_(it.name) === norm_(name)) found = { k: k, g: g, item: it }; });
  });
  if (req.create) {
    if (found) throw new Error('"' + name + '" already exists in ' + found.g.sheet.getName() + '.');
    var sheet = findSheet_(ss, SHEETS[kind]);
    if (!sheet) throw new Error('Sheet for ' + kind + ' not found.');
    var g2 = parseGrid_(sheet, tz);
    var last = g2.items.length ? g2.items[g2.items.length - 1].row : g2.dateRow + 1;
    sheet.insertRowAfter(last + 1);
    sheet.getRange(last + 2, 1).setValue(name);
  } else {
    if (!found || found.k === 'products') throw new Error('"' + name + '" is not a Daily Do or Habit.');
    kind = found.k;
    name = found.item.name;
  }

  var sh2 = ss.getSheetByName(TASK_SHEET);
  if (!sh2) {
    sh2 = ss.insertSheet(TASK_SHEET);
    sh2.getRange(1, 1, 1, 6).setValues([['Task', 'List', 'Start date', 'Duration (min)', 'Priority', 'Period']])
      .setFontWeight('bold').setFontColor('#ffffff').setBackground('#2F5496');
    sh2.getRange('C:C').setNumberFormat('@');
    sh2.setColumnWidth(1, 220); sh2.setFrozenRows(1);
  }
  var values = sh2.getDataRange().getValues(), row = -1;
  for (var r = 1; r < values.length; r++) {
    if (norm_(values[r][0]) === norm_(name)) { row = r + 1; break; }
  }
  if (row < 0) row = Math.max(sh2.getLastRow(), 1) + 1;
  sh2.getRange(row, 1, 1, 6).setNumberFormats([['@', '@', '@', '0', '0', '@']])
    .setValues([[name, kind === 'habits' ? 'Habits' : 'Daily Dos', start, duration, priority, period]]);
  return { saved: true };
}

// ---------- month buy list ----------

function parseBuy_(sh) {
  var values = sh.getDataRange().getValues();
  var hRow = -1;
  for (var r = 0; r < Math.min(10, values.length) && hRow < 0; r++) {
    for (var c = 0; c < values[r].length; c++) {
      if (/^product\s*-?\s*1$/i.test(String(values[r][c]).trim())) { hRow = r; break; }
    }
  }
  if (hRow < 0) throw new Error('Could not find "Product-1" header in "' + sh.getName() + '".');

  var slots = [];   // [{n, nameCol, costCol}]
  var head = values[hRow];
  for (var c2 = 0; c2 < head.length; c2++) {
    var m = String(head[c2]).trim().match(/^product\s*-?\s*(\d+)$/i);
    if (m) slots.push({ n: Number(m[1]), nameCol: c2, costCol: c2 + 1 });
  }
  slots.sort(function (a, b) { return a.n - b.n; });

  var monthRows = {}, months = {};
  for (var r2 = hRow + 1; r2 < values.length; r2++) {
    var label = String(values[r2][0]).trim();
    var idx = MONTHS.map(function (x) { return x.toLowerCase(); }).indexOf(label.toLowerCase());
    if (idx < 0) continue;
    monthRows[MONTHS[idx]] = r2;
    var list = [];
    slots.forEach(function (s) {
      var name = String(values[r2][s.nameCol] == null ? '' : values[r2][s.nameCol]).trim();
      var cost = values[r2][s.costCol];
      if (name) list.push({ product: name, cost: (cost === '' || isNaN(Number(cost))) ? null : Number(cost) });
    });
    months[MONTHS[idx]] = list;
  }
  return { sheet: sh, hRow: hRow, slots: slots, monthRows: monthRows, months: months, lastCol: head.length };
}

function getBuySettings_(ss, create) {
  var sh = ss.getSheetByName(BUY_SETTINGS);
  if (!sh && create) {
    sh = ss.insertSheet(BUY_SETTINGS);
    sh.getRange(1, 1, 1, 3).setValues([['Month', 'Budget (₹)', 'Notes']])
      .setFontWeight('bold').setFontColor('#ffffff').setBackground('#2F5496');
    sh.getRange(2, 1, 12, 1).setValues(MONTHS.map(function (m) { return [m]; }));
    sh.getRange(2, 2, 12, 1).setNumberFormat('#,##0');
    sh.setColumnWidth(1, 120); sh.setColumnWidth(2, 110); sh.setColumnWidth(3, 260);
    sh.setFrozenRows(1);
  }
  return sh;
}

function readBudgets_(ss) {
  var sh = getBuySettings_(ss, false);
  var out = {};
  if (!sh) return out;
  var values = sh.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    var m = String(values[r][0]).trim();
    if (MONTHS.indexOf(m) >= 0 && values[r][1] !== '' && !isNaN(Number(values[r][1]))) out[m] = Number(values[r][1]);
  }
  return out;
}

// ---------- actions ----------

function readAll_(ss) {
  var tz = ss.getSpreadsheetTimeZone();
  var out = { title: ss.getName(), timezone: tz, sheets: {} };
  ['products', 'dos', 'habits'].forEach(function (k) {
    var sh = findSheet_(ss, SHEETS[k]);
    out.sheets[k] = sh ? gridToJson_(parseGrid_(sh, tz)) : null;
  });
  var p = findSheet_(ss, SHEETS.period);
  if (p) { var pp = parsePeriod_(p, tz); out.sheets.period = { sheetName: p.getName(), dates: pp.dates, marked: pp.marked }; }
  var w = findSheet_(ss, SHEETS.weight);
  if (w) { var ww = parseWeight_(w, tz); out.sheets.weight = { sheetName: w.getName(), dates: ww.dates, entries: ww.entries, night: ww.night }; }
  var b = findSheet_(ss, SHEETS.buy);
  if (b) { var bb = parseBuy_(b); out.sheets.buy = { sheetName: b.getName(), months: bb.months, slots: bb.slots.length }; }
  out.budgets = readBudgets_(ss);
  out.profile = readProfile_(ss);
  out.water = readWater_(ss, tz);
  out.sleep = readSleep_(ss, tz);
  out.tasks = readTasks_(ss, tz);
  out.work = readWork_(ss, tz);
  out.oneTime = readOneTime_(ss, tz);
  return out;
}

/**
 * req: { date:'yyyy-MM-dd',
 *        grid: { products:{name:true|false}, dos:{...}, habits:{...} },
 *        period: true|false|undefined,
 *        weight: { m?: number|'', n?: number|'' } (morning / night) | undefined }
 */
function saveDay_(ss, req) {
  var tz = ss.getSpreadsheetTimeZone();
  var date = String(req.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date.');
  var changed = 0;

  var grid = req.grid || {};
  ['products', 'dos', 'habits'].forEach(function (k) {
    var changes = grid[k];
    if (!changes || !Object.keys(changes).length) return;
    var sh = findSheet_(ss, SHEETS[k]);
    if (!sh) throw new Error('Sheet for ' + k + ' not found.');
    var g = parseGrid_(sh, tz);
    Object.keys(changes).forEach(function (name) {
      setGridMark_(g, name, date, !!changes[name], k === 'products');
      changed++;
    });
  });

  if (typeof req.period === 'boolean') {
    var p = parsePeriod_(findSheet_(ss, SHEETS.period), tz);
    var cell = p.cells[date];
    if (!cell) throw new Error(date + ' is not on the period calendar.');
    p.sheet.getRange(cell.row + 1, cell.col + 1).setValue(req.period ? 'X' : '');
    changed++;
  }

  if (req.weight !== undefined && req.weight !== null) {
    var w = parseWeight_(findSheet_(ss, SHEETS.weight), tz);
    var row = w.rows[date];
    if (row === undefined) throw new Error(date + ' is not in the weight sheet.');
    var wt = typeof req.weight === 'object' ? req.weight : { m: req.weight };   // a plain number means morning
    if (wt.m !== undefined) {
      w.sheet.getRange(row + 1, w.wCol + 1).setValue(weightCell_(wt.m));
      changed++;
    }
    if (wt.n !== undefined) {
      var nv = weightCell_(wt.n);
      if (nv !== '' || w.nCol >= 0) w.sheet.getRange(row + 1, ensureNightCol_(w) + 1).setValue(nv);
      changed++;
    }
  }
  return { changed: changed };
}

/** req: { days: [ <saveDay request>, … ] } — several dates in one call (week view) */
function saveDays_(ss, req) {
  var days = req.days || [];
  if (days.length > 62) throw new Error('Too many days in one save.');
  var changed = 0;
  days.forEach(function (d) { changed += saveDay_(ss, d).changed; });
  return { changed: changed, days: days.length };
}

/** req: { month:'October', items:[{product, cost}], budget: number|''|undefined } */
function saveBuyList_(ss, req) {
  var month = String(req.month || '');
  if (MONTHS.indexOf(month) < 0) throw new Error('Unknown month: ' + month);
  var sh = findSheet_(ss, SHEETS.buy);
  if (!sh) throw new Error('"Month List To buy" sheet not found.');
  var b = parseBuy_(sh);
  var row = b.monthRows[month];
  if (row === undefined) throw new Error(month + ' row not found in "' + sh.getName() + '".');

  var items = (req.items || []).filter(function (it) { return it && String(it.product || '').trim(); });

  // add more Product/Cost column pairs when a month needs them
  var lastCol = sh.getLastColumn();
  var headerRange = sh.getRange(b.hRow + 1, lastCol);
  while (b.slots.length < items.length) {
    var n = b.slots.length ? b.slots[b.slots.length - 1].n + 1 : 1;
    sh.getRange(b.hRow + 1, lastCol + 1, 1, 2).setValues([['Product-' + n, 'Product - ' + n + ' Cost Approx']]);
    headerRange.copyTo(sh.getRange(b.hRow + 1, lastCol + 1, 1, 2), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    b.slots.push({ n: n, nameCol: lastCol, costCol: lastCol + 1 });
    lastCol += 2;
  }

  b.slots.forEach(function (s, i) {
    var it = items[i];
    var name = it ? String(it.product).trim() : '';
    var cost = (it && it.cost !== '' && it.cost !== null && !isNaN(Number(it.cost))) ? Number(it.cost) : '';
    sh.getRange(row + 1, s.nameCol + 1).setValue(name);
    sh.getRange(row + 1, s.costCol + 1).setValue(name ? cost : '');
  });

  if (req.budget !== undefined) {
    var bs = getBuySettings_(ss, true);
    var r = MONTHS.indexOf(month) + 2;
    bs.getRange(r, 2).setValue(req.budget === '' || req.budget === null ? '' : Number(req.budget));
  }
  return { saved: items.length };
}

/**
 * req: { product, date:'yyyy-MM-dd', bought: true|false }
 * A product that is already in Products gets an X there (it feeds the restock reminders).
 * Anything else is a one-time buy: it is recorded in its own sheet and never added to Products.
 */
function markBought_(ss, req) {
  var tz = ss.getSpreadsheetTimeZone();
  var product = String(req.product || ''), date = String(req.date || '');
  var sh = findSheet_(ss, SHEETS.products);
  if (sh) {
    var g = parseGrid_(sh, tz);
    var known = g.items.some(function (it) { return norm_(it.name) === norm_(product); });
    if (known) { setGridMark_(g, product, date, req.bought !== false, false); return { ok: true, oneTime: false }; }
  }
  setOneTime_(ss, tz, product, date, req.bought !== false);
  return { ok: true, oneTime: true };
}

// ---------- one-time buys: Date | Product ----------

var ONETIME_SHEET = 'One-time Buys';

function readOneTime_(ss, tz) {
  var sh = ss.getSheetByName(ONETIME_SHEET), out = [];
  if (!sh) return out;
  var values = sh.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    var k = waterDateKey_(values[r][0], tz), name = String(values[r][1] == null ? '' : values[r][1]).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(k) && name) out.push({ product: name, date: k });
  }
  return out;
}

function setOneTime_(ss, tz, product, date, on) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date.');
  product = product.trim();
  if (!product) throw new Error('Product name is empty.');
  var sh = ss.getSheetByName(ONETIME_SHEET);
  if (!sh) {
    if (!on) return;
    sh = ss.insertSheet(ONETIME_SHEET);
    sh.getRange(1, 1, 1, 2).setValues([['Date', 'Product']])
      .setFontWeight('bold').setFontColor('#ffffff').setBackground('#2F5496');
    sh.getRange('A:A').setNumberFormat('@');
    sh.setColumnWidth(1, 100); sh.setColumnWidth(2, 260); sh.setFrozenRows(1);
  }
  var values = sh.getDataRange().getValues(), row = -1;
  for (var r = values.length - 1; r >= 1; r--) {
    if (waterDateKey_(values[r][0], tz) === date && norm_(values[r][1]) === norm_(product)) { row = r + 1; break; }
  }
  if (on && row < 0) {
    var next = Math.max(sh.getLastRow(), 1) + 1;
    sh.getRange(next, 1).setNumberFormat('@').setValue(date);
    sh.getRange(next, 2).setValue(product);
  } else if (!on && row > 0) {
    sh.deleteRow(row);
  }
}