/* Life Tracker — GitHub Pages front end
 * Talks to an Apps Script web app (see apps-script/Code.gs) that reads/writes the Google Sheet.
 * No build step, no framework. Chart.js is loaded from cdnjs.
 */
'use strict';

/* =========================================================
 * Small utilities
 * ======================================================= */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'text') e.textContent = v;
      else if (['value', 'checked', 'disabled', 'type', 'min', 'max', 'step', 'placeholder', 'hidden', 'open'].includes(k)) e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

// append/replace children, skipping empty slots (null/false) instead of printing them
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false));

const store = {
  get(k, fallback) { try { const v = localStorage.getItem('lt.' + k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem('lt.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem('lt.' + k); } catch { /* ignore */ } }
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// dates are 'YYYY-MM-DD' strings everywhere
const pad = n => String(n).padStart(2, '0');
const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return keyOf(d); };
const diffDays = (a, b) => Math.round((parseKey(b) - parseKey(a)) / 864e5);
const todayKey = () => keyOf(new Date());
const dow = k => parseKey(k).getDay();
const monthOf = k => k.slice(0, 7);
const fmt = (k, o = { day: 'numeric', month: 'short' }) => parseKey(k).toLocaleDateString('en-IN', o);
const fmtLong = k => fmt(k, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const monthLabel = ym => { const [y, m] = ym.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; };
const rupee = n => n === null || n === undefined || isNaN(n) ? '—' : '₹' + Math.round(n).toLocaleString('en-IN');
const pct = (x, d = 0) => x === null || x === undefined || isNaN(x) ? '—' : (x * 100).toFixed(d) + '%';
const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const rangeDays = (a, b) => { const out = []; for (let k = a; k <= b; k = addDays(k, 1)) out.push(k); return out; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, isErr ? 6000 : 2600);
}

// full-screen loading overlay with rotating motivation
const QUOTES = [
  'Small steps every day add up to big change.',
  'Drink water. Your future self says thanks.',
  'You do not have to be perfect, just consistent.',
  'Move your body: even ten minutes counts.',
  'Eat colourful, feel energetic.',
  'Progress, not perfection.',
  'A healthy habit today is a gift to tomorrow.',
  'Your body hears everything your mind says. Be kind.',
  'Sip, stretch, smile, repeat.',
  'Tracking it is the first step to changing it.'
];
const loaderQuote = { i: Math.floor(Math.random() * QUOTES.length), t: null };
function setLoader(on) {
  const l = $('#loader');
  if (!l) return;
  l.hidden = !on;
  clearInterval(loaderQuote.t);
  if (!on) return;
  const q = $('#loaderQuote'), show = () => { q.textContent = QUOTES[loaderQuote.i++ % QUOTES.length]; };
  show();
  loaderQuote.t = setInterval(() => {
    q.classList.add('fade');
    setTimeout(() => { show(); q.classList.remove('fade'); }, 400);
  }, 2800);
}

/* =========================================================
 * State
 * ======================================================= */
const S = {
  user: null,          // signed-in member { uid, userName, email, role }
  members: [],         // admin only: everyone, for the person picker
  years: [],           // document_link rows of the person being viewed
  year: null,
  viewUid: null,       // whose tracker is on screen (admin can view others, read-only)
  readOnly: false,
  demo: false,
  data: null,          // raw response of 'read'
  idx: null,           // derived indexes
  tab: 'log',
  logDate: todayKey(),
  pending: null,
  buyMonth: null,
  buyDraft: null,
  buyDirty: false,
  mode: 'day',
  weekCat: 'dos',
  countFns: [],
  view: 'overview',
  groupMode: false,    // admin 'Everyone' view
  group: null,
  memberYears: {},     // admin: uid -> that person's document_link rows
  gRange: null,
  gMonths: null,
  range: 'all',
  charts: []
};
const freshPending = () => ({ grid: { products: {}, dos: {}, habits: {} }, period: {}, weight: {}, newProducts: [] });
S.pending = freshPending();

/* =========================================================
 * API
 * ======================================================= */
async function api(action, payload = {}) {
  if (S.demo) return demoApi(action, payload);
  const scriptUrl = window.APP_CONFIG?.scriptUrl;
  if (!scriptUrl) throw new Error('scriptUrl is missing in config.js.');
  const idToken = await Account.token();
  const asUid = S.viewUid && S.viewUid !== S.user.uid ? S.viewUid : undefined;
  const res = await fetch(scriptUrl, {
    method: 'POST',
    // no content-type header => text/plain, so the browser skips the CORS preflight Apps Script can't answer
    body: JSON.stringify({ action, idToken, year: S.year, asUid, ...payload })
  });
  let j;
  try { j = await res.json(); } catch { throw new Error('The script did not return JSON. Check the deployment URL and that access is "Anyone".'); }
  if (!j.ok) throw new Error(j.error || 'Request failed');
  return j.data;
}

// applies a write to the in-memory data — used by demo mode and for instant UI updates
function applyLocal(action, p) {
  const sh = S.data.sheets;
  const setMark = (sheet, name, date, on, allowAdd) => {
    if (!sheet) return;
    let it = sheet.items.find(i => norm(i.name) === norm(name));
    if (!it) { if (!on || !allowAdd) return; it = { name: name.trim(), marked: [] }; sheet.items.push(it); }
    const has = it.marked.includes(date);
    if (on && !has) { it.marked.push(date); it.marked.sort(); }
    if (!on && has) it.marked = it.marked.filter(d => d !== date);
  };
  if (action === 'saveDay') {
    for (const k of ['products', 'dos', 'habits']) {
      for (const [name, on] of Object.entries(p.grid[k] || {})) setMark(sh[k], name, p.date, on, k === 'products');
    }
    if (typeof p.period === 'boolean' && sh.period) {
      const m = new Set(sh.period.marked);
      p.period ? m.add(p.date) : m.delete(p.date);
      sh.period.marked = [...m].sort();
    }
    if (p.weight !== undefined && sh.weight) {
      const wt = typeof p.weight === 'object' ? p.weight : { m: p.weight };   // plain number = morning
      const put = (map, v) => { if (v === '') delete map[p.date]; else map[p.date] = Number(v); };
      if (wt.m !== undefined) put(sh.weight.entries, wt.m);
      if (wt.n !== undefined) put(sh.weight.night ||= {}, wt.n);
    }
  } else if (action === 'saveDays') {
    p.days.forEach(d => applyLocal('saveDay', d));
  } else if (action === 'saveBuyList') {
    sh.buy.months[p.month] = p.items.map(i => ({ product: i.product, cost: i.cost === '' || i.cost === null ? null : Number(i.cost) }));
    sh.buy.slots = Math.max(sh.buy.slots, p.items.length);
    if (p.budget !== undefined) {
      if (p.budget === '' || p.budget === null) delete S.data.budgets[p.month]; else S.data.budgets[p.month] = Number(p.budget);
    }
  } else if (action === 'markBought') {
    setMark(sh.products, p.product, p.date, p.bought !== false, true);
  } else if (action === 'saveProfile') {
    S.data.profile = { height: Number(p.height), waterGoal: Number(p.waterGoal), tumbler: Number(p.tumbler) };
  } else if (action === 'addWater' || action === 'undoWater') {
    const goal = S.data.profile.waterGoal;
    const day = (S.data.water.days[p.date] ||= { goal, total: 0, log: [] });
    if (action === 'addWater') day.log.push({ t: p.time, ml: p.ml }); else day.log.pop();
    day.total = day.log.reduce((s, e) => s + e.ml, 0);
    day.goal = goal;
  } else if (action === 'setSleep') {
    const day = (S.data.sleep.days[p.date] ||= { wake: '', sleep: '' });
    day[p.kind] = p.time;
  }
}

async function demoApi(action, payload) {
  await new Promise(r => setTimeout(r, 250));
  if (action === 'read') return S.data || makeDemoData();
  if (action === 'ping') return {};
  applyLocal(action, payload);
  return { ok: true };
}

/* =========================================================
 * Loading & indexing
 * ======================================================= */
async function loadSheet({ quiet = false } = {}) {
  if (!S.demo && !S.year) { toast('Choose a year first, or upload one in the Upload tab.', true); return; }
  const btn = $('#loadBtn');
  btn.disabled = true; btn.textContent = 'Loading…';
  if (!quiet) setLoader(true);
  S.groupMode = false;
  $$('.grp').forEach(e => { e.hidden = true; });
  try {
    const data = await api('read');
    data.profile ||= { height: null, waterGoal: null, tumbler: null };
    data.water ||= { days: {} };
    data.sleep ||= { days: {} };
    if (hidesPeriod()) data.sheets.period = null;   // male accounts: no period tracking or analysis
    S.data = data;
    buildIndex();
    S.readOnly = !S.demo && S.viewUid !== S.user.uid;
    document.body.classList.toggle('readonly', S.readOnly);
    $$('[data-sheet-title]').forEach(e => { e.textContent = (S.demo ? 'Demo · ' : '') + data.title; });
    $$('[data-empty]').forEach(e => { e.hidden = true; });
    $$('[data-ready]').forEach(e => { e.hidden = false; });
    showBanner();
    if (!quiet) {
      S.pending = freshPending();
      S.logDate = clampDate(S.logDate);
      S.buyDraft = null; S.buyDirty = false;
      if (!S.buyMonth) S.buyMonth = defaultBuyMonth();
    }
    renderAll();
    renderGroupEditor();
    renderProfileBox();
    if (!quiet) maybePromptProfile();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false; btn.textContent = 'Load';
    if (!quiet) setLoader(false);
  }
}

function buildIndex() {
  const sh = S.data.sheets;
  const grid = k => {
    const s = sh[k];
    if (!s) return null;
    const sets = {};
    s.items.forEach(i => { sets[i.name] = new Set(i.marked); });
    const loggedDays = new Set(s.items.flatMap(i => i.marked));
    return { dates: s.dates, dateSet: new Set(s.dates), items: s.items.map(i => i.name), sets, loggedDays };
  };
  const allDates = [...new Set([...(sh.dos?.dates || []), ...(sh.habits?.dates || []), ...(sh.products?.dates || []), ...(sh.period?.dates || []), ...(sh.weight?.dates || [])])].sort();
  S.idx = {
    products: grid('products'), dos: grid('dos'), habits: grid('habits'),
    period: sh.period ? { dateSet: new Set(sh.period.dates), marked: new Set(sh.period.marked) } : null,
    weight: sh.weight ? { dateSet: new Set(sh.weight.dates), entries: sh.weight.entries, night: (sh.weight.night ||= {}) } : null,
    first: allDates[0], last: allDates[allDates.length - 1],
    year: (allDates[0] || todayKey()).slice(0, 4)
  };
}

function clampDate(k) {
  if (!S.idx) return k;
  if (k < S.idx.first) return S.idx.first;
  if (k > S.idx.last) return S.idx.last;
  return k;
}

function showBanner() {
  const b = $('#banner');
  const missing = ['products', 'dos', 'habits', 'period', 'weight', 'buy'].filter(k => !S.data.sheets[k] && !(k === 'period' && hidesPeriod()));
  if (S.demo) {
    b.className = 'banner info'; b.hidden = false;
    b.textContent = 'Demo mode — made-up data, changes stay in this tab. Pick a year above and press Load to go back to your tracker.';
  } else if (S.readOnly) {
    const who = S.members.find(m => m.uid === S.viewUid)?.userName || 'this person';
    b.className = 'banner info'; b.hidden = false;
    b.textContent = `Viewing ${who}'s ${S.year} tracker.`;
  } else if (missing.length) {
    b.className = 'banner'; b.hidden = false;
    b.textContent = 'Some sheets were not found in this file: ' + missing.join(', ') + '. Those sections are hidden.';
  } else b.hidden = true;
}

/* =========================================================
 * Tabs
 * ======================================================= */
function switchTab(tab) {
  S.tab = tab;
  $$('.nav-btn').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  window.scrollTo(0, 0);
  $$('.tab-panel').forEach(p => { p.hidden = p.id !== 'tab-' + tab; });
  if (S.data || S.groupMode || ['upload', 'files', 'admin', 'settings'].includes(tab)) renderTab();
}
function renderAll() { renderTab(); }
function renderTab() {
  if (S.groupMode && ['log', 'buy', 'analysis'].includes(S.tab)) return renderGroupTab(S.tab);
  if (S.tab === 'log') renderLog();
  else if (S.tab === 'buy') renderBuy();
  else if (S.tab === 'analysis') renderAnalysis();
  else if (S.tab === 'settings') { renderGroupEditor(); renderProfileBox(); }
  else if (S.tab === 'upload') renderUpload();
  else if (S.tab === 'files') renderFiles();
  else if (S.tab === 'admin') renderAdmin();
}

/* =========================================================
 * ICONS & GROUPS
 * ======================================================= */
const ICONS = [
  [/brush teeth|teeth|colgate|tooth/i, 'dental'], [/bath|shower/i, 'bath'], [/breakfast/i, 'coffee'], [/lunch/i, 'salad'],
  [/dinner/i, 'tools-kitchen-2'], [/exercise|workout|gym|walk|run/i, 'run'], [/bed/i, 'bed'], [/language/i, 'language'],
  [/meditat|yoga/i, 'yoga'], [/face exercise|face massage/i, 'mood-smile'], [/face/i, 'droplet'], [/read|book|art/i, 'book'],
  [/restroom/i, 'hourglass'], [/study|tech|learn|course/i, 'device-laptop'], [/work/i, 'briefcase'], [/curry|leaf|leaves/i, 'leaf'],
  [/oil/i, 'bottle'], [/seed|fenu/i, 'seeding'], [/nut|badam|cashew|walnut|almond/i, 'nut'], [/sugar|sweet/i, 'candy-off'],
  [/sun|vitamin/i, 'sun'], [/\btea\b|coffee/i, 'cup'], [/water/i, 'glass-full'], [/serum|mask/i, 'flask'], [/hair/i, 'brush'],
  [/cheese/i, 'cheese'], [/maida|bread/i, 'bread-off'], [/harpic|toilet|cleaner|spray/i, 'spray'], [/razor/i, 'razor'],
  [/fruit|apple/i, 'apple'], [/salt|powder|turmeric/i, 'salt'], [/dettol/i, 'first-aid-kit'], [/balls/i, 'circle-dot'],
  [/surf/i, 'wash-machine'], [/soap|wash|scrub|clinic|shampoo|conditioner|lotion|cream/i, 'bottle'], [/brush/i, 'brush'], [/egg/i, 'egg']
];
const iconFor = (name, k) => (ICONS.find(([re]) => re.test(name)) || [0, k === 'products' ? 'shopping-bag' : 'circle-check'])[1];
const icon = (name, cls = '') => h('i', { class: `ti ti-${name} ${cls}`, 'aria-hidden': 'true' });

const GROUPS = [['Morning', 'sunrise'], ['Daytime', 'sun-high'], ['Evening', 'moon']];
function autoGroup(name) {
  if (/morning|breakfast|bath|fold bed|vitamin/i.test(name)) return 'Morning';
  if (/night|dinner|evening|sleep/i.test(name)) return 'Evening';
  return 'Daytime';
}
const groupOf = name => store.get('groups', {})[name] || autoGroup(name);

/* =========================================================
 * TODAY — pending edits can span many days
 * ======================================================= */
const pkey = (date, name) => date + '|' + name;
function originalGrid(k, name, date) { return !!S.idx[k]?.sets[name]?.has(date); }
function currentGrid(k, name, date) {
  const p = S.pending.grid[k], key = pkey(date, name);
  return key in p ? p[key] : originalGrid(k, name, date);
}
function setGrid(k, name, date, on) {
  const p = S.pending.grid[k], key = pkey(date, name);
  if (on === originalGrid(k, name, date)) delete p[key]; else p[key] = on;
}
const originalPeriod = date => !!S.idx.period?.marked.has(date);
const currentPeriod = date => date in S.pending.period ? S.pending.period[date] : originalPeriod(date);
function setPeriod(date, on) { if (on === originalPeriod(date)) delete S.pending.period[date]; else S.pending.period[date] = on; }
function pendingCount() {
  const p = S.pending;
  return Object.values(p.grid).reduce((s, o) => s + Object.keys(o).length, 0) + Object.keys(p.period).length + Object.values(p.weight).reduce((s, o) => s + Object.keys(o).length, 0);
}
function pendingDates() {
  const p = S.pending, out = new Set([...Object.keys(p.period), ...Object.keys(p.weight)]);
  Object.values(p.grid).forEach(o => Object.keys(o).forEach(k => out.add(k.slice(0, 10))));
  return out;
}
/* weight: morning ('m') lives in the sheet's Weight column, night ('n') in its own column */
const origW = (date, w) => (w === 'm' ? S.idx.weight.entries : S.idx.weight.night)[date];
function curW(date, w) {
  const p = S.pending.weight[date]?.[w];
  const v = p !== undefined ? p : origW(date, w);
  return v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v);
}
/** most recent weigh-in on or before `date`; night beats morning on the same day */
function latestWeigh(date) {
  const iw = S.idx.weight;
  if (!iw) return null;
  const days = new Set([...Object.keys(iw.entries), ...Object.keys(iw.night), ...Object.keys(S.pending.weight)]);
  for (const d of [...days].filter(x => x <= date).sort().reverse()) {
    const n = curW(d, 'n'), m = curW(d, 'm');
    if (n !== null || m !== null) return { date: d, kg: n ?? m, when: n !== null ? 'night' : 'morning' };
  }
  return null;
}

/** BMI (WHO bands) plus the healthy weight range for this height */
function bmiInfo(kg, cm) {
  const m = cm / 100, bmi = kg / (m * m);
  const lo = +(18.5 * m * m).toFixed(1), hi = +(24.9 * m * m).toFixed(1);
  let label, cls, ico, advice;
  if (bmi < 16) { label = 'Severely underweight'; cls = 'bad'; ico = 'alert-triangle'; advice = `About ${(lo - kg).toFixed(1)} kg below the healthy range. Please speak to a doctor.`; }
  else if (bmi < 18.5) { label = 'Underweight'; cls = 'warn'; ico = 'alert-triangle'; advice = `About ${(lo - kg).toFixed(1)} kg below the healthy range. Consider eating a bit more or checking with a dietitian.`; }
  else if (bmi < 25) { label = 'Healthy weight'; cls = 'good'; ico = 'circle-check'; advice = 'Right in the healthy range. Keep it up.'; }
  else if (bmi < 30) { label = 'Overweight'; cls = 'warn'; ico = 'alert-triangle'; advice = `About ${(kg - hi).toFixed(1)} kg above the healthy range.`; }
  else { label = 'Obese'; cls = 'bad'; ico = 'alert-octagon'; advice = `About ${(kg - hi).toFixed(1)} kg above the healthy range. Consider checking in with a doctor.`; }
  return { bmi, label, cls, ico, advice, lo, hi };
}

function streakEnding(set, date) { let n = 0, k = date; while (set.has(k)) { n++; k = addDays(k, -1); } return n; }

function dayScore(date) {
  let done = 0, total = 0;
  for (const k of ['dos', 'habits']) {
    const ix = S.idx[k]; if (!ix) continue;
    total += ix.items.length;
    done += ix.items.filter(n => currentGrid(k, n, date)).length;
  }
  return { done, total, pct: total ? done / total : 0 };
}
const ringBg = pct => `conic-gradient(var(--done) ${Math.round(pct * 360)}deg, var(--miss) 0)`;
const mondayOf = k => addDays(k, -((dow(k) + 6) % 7));

function renderLog() {
  const date = S.logDate, t = todayKey();
  $('#dateLabel').textContent = date === t ? 'Today' : fmt(date, { weekday: 'long' });
  $('#dateSub').textContent = fmt(date, { day: 'numeric', month: 'long', year: 'numeric' }) + (date === t ? ` · ${fmt(date, { weekday: 'long' })}` : '');
  if (date !== t && t >= S.idx.first && t <= S.idx.last) $('#dateSub').append(' · ', h('button', { class: 'linkbtn', onclick: () => { S.logDate = t; renderLog(); } }, 'Go to today'));
  $$('.seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === S.mode)));
  S.countFns = [];
  renderWeekStrip();
  const body = $('#logBody');
  fill(body, S.mode === 'week' ? buildWeek() : buildDay());
  updateSaveBar();
}

function updateLogMeta() {
  renderWeekStrip();
  const old = $('#summaryCard');
  if (old) old.replaceWith(buildSummary(S.logDate));
  S.countFns.forEach(f => f());
  updateSaveBar();
}

function renderWeekStrip() {
  const start = mondayOf(S.logDate), t = todayKey(), pend = pendingDates();
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const strip = $('#weekStrip');
  const inRange = d => d >= S.idx.first && d <= S.idx.last;
  fill(strip,
    h('button', { class: 'icon-btn', 'aria-label': 'Previous week', disabled: addDays(start, -1) < S.idx.first, onclick: () => { S.logDate = clampDate(addDays(S.logDate, -7)); renderLog(); } }, icon('chevron-left')),
    h('div', { class: 'week-days' }, days.map(d => {
      const sc = dayScore(d);
      return h('button', {
        class: 'day-chip' + (d === S.logDate ? ' sel' : '') + (d === t ? ' today' : '') + (pend.has(d) ? ' pend' : ''),
        disabled: !inRange(d), 'aria-label': fmtLong(d) + ` — ${sc.done} of ${sc.total} done`,
        onclick: () => { S.logDate = d; renderLog(); }
      }, h('span', { class: 'dw' }, DOW[dow(d)]), h('span', { class: 'dn' }, parseKey(d).getDate()),
        h('span', { class: 'ring', style: `background:${ringBg(sc.pct)}` }));
    })),
    h('button', { class: 'icon-btn', 'aria-label': 'Next week', disabled: addDays(start, 7) > S.idx.last, onclick: () => { S.logDate = clampDate(addDays(S.logDate, 7)); renderLog(); } }, icon('chevron-right')),
    !days.includes(t) && inRange(t) ? h('button', { class: 'btn small ghost', onclick: () => { S.logDate = t; renderLog(); } }, 'Today') : null
  );
}

function buildSummary(date) {
  const sc = dayScore(date);
  const pills = [];
  if (S.idx.period) {
    const P = analyzePeriod();
    if (currentPeriod(date)) pills.push(h('span', { class: 'pill pink' }, icon('droplet'), 'Period day'));
    if (P.periods.length) {
      const cd = cycleDayOn(P, date);
      if (cd) pills.push(h('span', { class: 'pill pink' }, `Cycle day ${cd.day} · ${cd.phase}`));
      if (P.next && date <= addDays(P.next, 10)) pills.push(h('span', { class: 'pill' }, P.late && date >= P.next ? `Period ${plural(P.late, 'day')} late` : `Next period ${fmt(P.next)}`));
    }
  }
  if (S.idx.weight) {
    const wm = curW(date, 'm'), wn = curW(date, 'n');
    if (wm !== null || wn !== null) pills.push(h('span', { class: 'pill teal' }, icon('scale'), [wm !== null ? `AM ${wm}` : null, wn !== null ? `PM ${wn}` : null].filter(Boolean).join(' · ') + ' kg'));
    const lw = latestWeigh(date), cm = S.data.profile?.height;
    if (lw && cm) { const b = bmiInfo(lw.kg, cm); if (b.cls !== 'good') pills.push(h('span', { class: 'pill ' + b.cls }, icon(b.ico), `BMI ${b.bmi.toFixed(1)} · ${b.label}`)); }
  }
  const best = ['dos', 'habits'].flatMap(k => (S.idx[k]?.items || []).map(n => ({ n, s: streakEnding(S.idx[k].sets[n], addDays(date, -1)) + (currentGrid(k, n, date) ? 1 : 0) }))).sort((a, b) => b.s - a.s)[0];
  if (best && best.s >= 3) pills.push(h('span', { class: 'pill' }, icon('flame'), `${best.n} · ${best.s} days`));
  const left = sc.total - sc.done;
  return h('div', { class: 'card summary', id: 'summaryCard' },
    h('div', { class: 'big-ring', style: `background:${ringBg(sc.pct)}` }, h('div', null, Math.round(sc.pct * 100) + '%')),
    h('div', null,
      h('div', { class: 'lead' }, `${sc.done} of ${sc.total} done`),
      h('p', { class: 'sub' }, left === 0 ? 'Everything ticked. Lovely.' : `${plural(left, 'item')} to go across Daily Dos and Habits`),
      pills.length ? h('div', { class: 'pillset' }, pills) : null));
}

function tapTile(k, name, date, extra = {}) {
  const ix = S.idx[k];
  const inSheet = ix.dateSet.has(date);
  const btn = h('button', { class: 'tap', disabled: !inSheet, title: inSheet ? name : 'This date is not in the sheet' });
  const paint = () => {
    const on = currentGrid(k, name, date);
    btn.classList.toggle('on', on);
    btn.classList.toggle('changed', pkey(date, name) in S.pending.grid[k]);
    btn.setAttribute('aria-pressed', String(on));
    const streak = ix.sets[name] ? streakEnding(ix.sets[name], addDays(date, -1)) + (on ? 1 : 0) : 0;
    let meta = null;
    if (k !== 'products' && streak >= 2) meta = h('span', { class: 'tm', title: `${streak}-day streak` }, icon('flame'), streak);
    if (k === 'products' && extra.last) meta = h('span', { class: 'tm', title: 'Last bought' }, fmt(extra.last));
    fill(btn, icon(iconFor(name, k), 'ic'),
      extra.planned ? h('span', { class: 'tag-mini' }, 'On list') : null,
      h('span', { class: 'tn' }, name), meta, h('span', { class: 'ck' }, icon('check')));
  };
  btn.addEventListener('click', () => { setGrid(k, name, date, !currentGrid(k, name, date)); paint(); updateLogMeta(); });
  paint();
  return btn;
}

function section(iconName, title, countFn, ...content) {
  const count = h('span', { class: 'count' });
  if (countFn) { const f = () => { count.textContent = countFn(); }; f(); S.countFns.push(f); }
  return h('div', { class: 'section' }, h('div', { class: 'section-head' }, icon(iconName), h('h2', null, title), count), ...content);
}

function buildDay() {
  const date = S.logDate;
  const wrap = h('div');
  wrap.append(buildSummary(date));
  const doneOf = (k, names) => () => `${names.filter(n => currentGrid(k, n, date)).length}/${names.length}`;

  if (S.idx.dos) {
    for (const [g, ic] of GROUPS) {
      const names = S.idx.dos.items.filter(n => groupOf(n) === g);
      if (!names.length) continue;
      wrap.append(section(ic, g, doneOf('dos', names), h('div', { class: 'tiles-grid' }, names.map(n => tapTile('dos', n, date)))));
    }
  }
  if (S.idx.habits) {
    const names = S.idx.habits.items;
    wrap.append(section('leaf', 'Habits', doneOf('habits', names), h('div', { class: 'tiles-grid' }, names.map(n => tapTile('habits', n, date)))));
  }

  // body: period + weight
  const body = [];
  if (S.idx.period) {
    const inCal = S.idx.period.dateSet.has(date);
    const pb = h('button', { class: 'tap pink', disabled: !inCal });
    const paintP = () => {
      const on = currentPeriod(date);
      pb.classList.toggle('on', on); pb.classList.toggle('changed', date in S.pending.period);
      pb.setAttribute('aria-pressed', String(on));
      fill(pb, icon('droplet', 'ic'), h('span', { class: 'tn' }, on ? 'Period day' : 'Period'), h('span', { class: 'ck' }, icon('check')));
    };
    pb.addEventListener('click', () => { setPeriod(date, !currentPeriod(date)); paintP(); updateLogMeta(); });
    paintP();
    body.push(pb);
  }
  if (S.idx.weight) body.push(buildWeightTile(date));
  if (body.length) {
    const sec = section('heart-rate-monitor', 'Body', null, h('div', { class: 'tiles-grid' }, body));
    if (S.idx.weight) {
      const box = h('div');
      const paintBmi = () => fill(box, buildBmi(date));
      paintBmi(); S.countFns.push(paintBmi);
      sec.append(box);
    }
    wrap.append(sec);
  }
  wrap.append(buildWater(date));
  wrap.append(buildSleep(date));

  if (S.idx.products) wrap.append(buildProducts(date));
  return wrap;
}

function buildWeightTile(date) {
  const enabled = S.idx.weight.dateSet.has(date);
  const prev = latestWeigh(addDays(date, -1));
  const tile = h('div', { class: 'tap weight' + (date in S.pending.weight ? ' changed' : '') });
  const field = (w, label, ico) => {
    const orig = origW(date, w);
    const inp = h('input', {
      type: 'number', step: '0.1', min: '20', max: '300', value: S.pending.weight[date]?.[w] ?? (orig ?? ''), placeholder: 'kg',
      inputmode: 'decimal', 'aria-label': `${label} weight in kg`, disabled: !enabled,
      oninput: e => {
        const v = e.target.value, o = orig === undefined ? '' : String(orig), pw = S.pending.weight;
        if (v === o) { if (pw[date]) { delete pw[date][w]; if (!Object.keys(pw[date]).length) delete pw[date]; } }
        else (pw[date] ||= {})[w] = v;
        tile.classList.toggle('changed', date in pw);
        updateLogMeta();
      }
    });
    return h('label', { class: 'wfield' }, h('span', { class: 'wl' }, icon(ico), label), h('div', { class: 'wrow' }, inp, h('span', null, 'kg')));
  };
  fill(tile, icon('scale', 'ic'),
    h('div', { class: 'wfields' }, field('m', 'Morning', 'sunrise'), field('n', 'Night', 'moon')),
    h('div', { class: 'tn' }, prev ? `Last ${prev.kg} kg (${prev.when}) · ${fmt(prev.date)}` : 'Weight'));
  return tile;
}

function buildBmi(date) {
  const cm = S.data.profile?.height, lw = latestWeigh(date);
  if (!cm) {
    return h('div', { class: 'bmi' }, icon('ruler-measure'), h('div', null, h('b', null, 'Add your height to see BMI'),
      h('p', { class: 'sub' }, 'We will warn you when your weight drifts out of the healthy range. ', h('button', { class: 'linkbtn', onclick: () => openProfileDialog() }, 'Set height'))));
  }
  if (!lw) return null;
  const b = bmiInfo(lw.kg, cm);
  return h('div', { class: 'bmi ' + b.cls }, icon(b.ico), h('div', null,
    h('b', null, `BMI ${b.bmi.toFixed(1)} · ${b.label}`),
    h('p', { class: 'sub' }, `${b.advice} Healthy range for ${cm} cm: ${b.lo}–${b.hi} kg. Based on ${lw.kg} kg (${lw.when}, ${fmt(lw.date)}).`)));
}

/* ---------- water tracker: a body that fills up ---------- */
const BODY_SHAPES = {
  female: '<circle cx="50" cy="20" r="13"/><path d="M36 38 L64 38 L67 58 L60 86 L75 142 L25 142 L40 86 L33 58 Z"/><path d="M33 42 L20 50 L14 98 L23 100 L31 66 Z"/><path d="M67 42 L80 50 L86 98 L77 100 L69 66 Z"/><path d="M33 138 L49 138 L47 228 L36 228 Z"/><path d="M51 138 L67 138 L64 228 L53 228 Z"/>',
  male: '<circle cx="50" cy="20" r="13"/><path d="M28 38 L72 38 L69 100 L65 128 L35 128 L31 100 Z"/><path d="M29 41 L16 50 L10 108 L21 110 L30 68 Z"/><path d="M71 41 L84 50 L90 108 L79 110 L70 68 Z"/><path d="M35 124 L49 124 L47 228 L35 228 Z"/><path d="M51 124 L65 124 L65 228 L53 228 Z"/>'
};
/* When the goal is met the body turns into a happy, glossy green figure (shown by .happy on .water-body). */
const HAPPY_LAYER = `<defs>
    <linearGradient id="hGrad" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0" spreadMethod="repeat">
      <stop offset="0" style="stop-color:color-mix(in srgb, var(--accent) 60%, white)"/>
      <stop offset=".5" style="stop-color:var(--accent-strong)"/>
      <stop offset="1" style="stop-color:color-mix(in srgb, var(--accent) 60%, white)"/>
      <animateTransform attributeName="gradientTransform" type="translate" from="0 0" to="100 0" dur="4s" repeatCount="indefinite"/>
    </linearGradient>
    <linearGradient id="hCyl" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#000" stop-opacity=".38"/><stop offset=".3" stop-color="#fff" stop-opacity=".22"/>
      <stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".42"/>
    </linearGradient>
    <radialGradient id="hGloss" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff" stop-opacity=".85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
  </defs>
  <g class="happy-layer" clip-path="url(#wclip)">
    <rect x="-10" y="0" width="120" height="240" fill="url(#hGrad)"/>
    <rect x="-10" y="0" width="120" height="240" fill="url(#hCyl)"/>
    <ellipse cx="44" cy="12" rx="6" ry="4" fill="url(#hGloss)"/>
    <ellipse cx="38" cy="52" rx="4" ry="14" fill="url(#hGloss)" opacity=".5"/>
  </g>
  <g class="face">
    <ellipse class="eye" cx="44.5" cy="17" rx="3" ry="3.6" fill="#fff"/><ellipse class="eye" cx="55.5" cy="17" rx="3" ry="3.6" fill="#fff"/>
    <circle class="pupil" cx="45" cy="17.6" r="1.5" fill="#0b2a20"/><circle class="pupil" cx="56" cy="17.6" r="1.5" fill="#0b2a20"/>
    <path d="M42.5 22.5 Q50 33.5 57.5 22.5 Z" fill="#0b2a20"/>
    <path d="M43.6 22.5 H56.4 Q54.6 26.6 50 26.9 Q45.4 26.6 43.6 22.5 Z" fill="#fff"/>
    <path d="M47 29.6 Q50 27.8 53 29.6 Q50 31.4 47 29.6 Z" fill="#e8737f"/>
    <ellipse cx="40.5" cy="22" rx="2.2" ry="1.4" fill="#ff8a9a" opacity=".45"/><ellipse cx="59.5" cy="22" rx="2.2" ry="1.4" fill="#ff8a9a" opacity=".45"/>
  </g>`;
const WAVE_PATH = 'M-100 4 Q-75 -3 -50 4 T0 4 T50 4 T100 4 T150 4 T200 4 V260 H-100 Z';
const svgBox = html => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; };
const nowHM = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const mlText = ml => Math.round(ml).toLocaleString('en-IN');

function buildWater(date) {
  const prof = S.data.profile, ready = prof.waterGoal && prof.tumbler;
  if (!ready) {
    return section('glass-full', 'Water tracker', null, h('div', { class: 'card water-card' },
      h('div', { class: 'water-info' }, h('b', null, 'Set up your water goal'),
        h('p', { class: 'sub' }, 'Choose how much you want to drink each day and the size of your tumbler, then tap to fill your body up.'),
        h('button', { class: 'btn primary', onclick: () => openProfileDialog() }, icon('droplet'), 'Set up'))));
  }
  const goal = prof.waterGoal, tumbler = prof.tumbler;
  const shape = viewedGender() === 'female' ? BODY_SHAPES.female : BODY_SHAPES.male;
  const fig = svgBox(`<svg viewBox="0 0 100 240" role="img" aria-label="Body filling with water">
    <defs><clipPath id="wclip">${shape}</clipPath></defs>
    <g class="outline">${shape}</g>
    <g class="shape">${shape}</g>
    <g clip-path="url(#wclip)"><g class="water-level"><g class="water-wave"><path d="${WAVE_PATH}" fill="var(--water)" opacity=".85"/></g></g></g>${HAPPY_LAYER}</svg>`);
  const level = $('.water-level', fig);
  const bodyBox = h('div', { class: 'water-body' }, fig);

  const total = h('div', { class: 'water-total' }), sub = h('p', { class: 'sub' }), logBox = h('div', { class: 'water-log' });
  const undoBtn = h('button', { class: 'btn small ghost', onclick: () => change(() => undoWater(date)) }, icon('arrow-back-up'), 'Undo last');
  const inRange = date >= S.idx.first && date <= S.idx.last;
  const paint = () => {
    const day = S.data.water.days[date] || { total: 0, log: [] };
    const p = day.total / goal;
    level.style.transform = `translateY(${7 + (1 - Math.min(p, 1)) * 223}px)`;
    bodyBox.classList.toggle('happy', p >= 1);
    fill(total, mlText(day.total), h('small', null, ` / ${mlText(goal)} ml · ${Math.round(p * 100)}%`));
    const left = goal - day.total;
    sub.textContent = !day.total ? `Nothing yet. Tap the tumbler when you drink.`
      : left > 0 ? `${mlText(left)} ml to go, about ${plural(Math.ceil(left / tumbler), 'tumbler')}.`
      : `Goal reached${day.total > goal ? ` (+${mlText(day.total - goal)} ml extra)` : ''}. Well done!`;
    fill(logBox, day.log.map(e => h('span', { class: 'tag' }, `${e.t} · +${e.ml} ml`)));
    undoBtn.disabled = !day.log.length;
  };
  const change = fn => { fn(); paint(); };
  const glass = svgBox('<svg viewBox="0 0 40 56"><defs><clipPath id="gclip"><path d="M5 3 H35 L31 50 Q31 54 27 54 H13 Q9 54 9 50 Z"/></clipPath></defs><path d="M5 3 H35 L31 50 Q31 54 27 54 H13 Q9 54 9 50 Z" fill="none" stroke="var(--water)" stroke-width="2.5" stroke-linejoin="round"/><rect x="0" y="20" width="40" height="40" fill="var(--water)" clip-path="url(#gclip)"/></svg>');
  const custom = h('input', { type: 'number', min: '1', max: '3000', step: '10', placeholder: 'ml', inputmode: 'numeric', 'aria-label': 'Custom amount in ml' });
  const addCustom = e => { e.preventDefault(); const ml = Number(custom.value); if (!(ml >= 1 && ml <= 3000)) return toast('Enter between 1 and 3000 ml.', true); change(() => drinkWater(date, ml)); custom.value = ''; };

  const card = h('div', { class: 'card water-card' },
    bodyBox,
    h('div', { class: 'water-info' }, total, sub,
      h('div', { class: 'water-actions' },
        h('button', { class: 'glass-btn', disabled: !inRange, onclick: () => change(() => drinkWater(date, tumbler)), 'aria-label': `Add one tumbler, ${tumbler} ml` },
          glass, h('span', null, `+ ${mlText(tumbler)} ml`, h('small', null, 'one tumbler'))),
        h('form', { class: 'water-custom', onsubmit: addCustom }, custom, h('button', { class: 'btn ghost', disabled: !inRange }, icon('plus'), 'Add')),
        undoBtn),
      logBox));
  paint();
  return section('glass-full', 'Water tracker', () => `${mlText(S.data.water.days[date]?.total || 0)} ml`, card);
}

/* ---------- sleep: tap Wake up / Sleep to stamp the current time ---------- */
const clockMins = t => { const [hh, mm] = t.split(':').map(Number); return hh * 60 + mm; };
const durText = m => `${Math.floor(m / 60)}h ${pad(m % 60)}m`;

function buildSleep(date) {
  const inRange = date >= S.idx.first && date <= S.idx.last, isToday = date === todayKey();
  const get = d => S.data.sleep.days[d] || { wake: '', sleep: '' };
  const summary = h('p', { class: 'sub' });
  const col = (kind, ico, label, doneLabel) => {
    const input = h('input', { type: 'time', 'aria-label': `${label} time`, disabled: !inRange,
      onchange: e => { sendQuick('setSleep', { date, kind, time: e.target.value }); paint(); } });
    const btn = h('button', { class: 'btn sleep-btn', disabled: !(inRange && isToday), title: isToday ? '' : 'Buttons record the current time, so they work on today only. Use the time box to fix other days.',
      onclick: () => { sendQuick('setSleep', { date, kind, time: nowHM() }); paint(); } }, icon(ico), label);
    const paintCol = () => { input.value = get(date)[kind]; };
    return { box: h('div', { class: 'sleep-col' }, btn, h('label', { class: 'sleep-time' }, h('span', null, doneLabel), input)), input, paintCol };
  };
  const wake = col('wake', 'sunrise', 'Wake up', 'Woke at'), bed = col('sleep', 'moon', 'Sleep', 'Slept at');
  function paint() {
    wake.paintCol(); bed.paintCol();
    const w = get(date).wake, prevBed = get(addDays(date, -1)).sleep;
    summary.textContent = w && prevBed ? `Last night: ${durText((clockMins(w) - clockMins(prevBed) + 1440) % 1440)} (${prevBed} → ${w})`
      : w || get(date).sleep ? "The sleep total appears once last night's bedtime and this morning's wake-up are both logged."
      : isToday ? 'Tap Wake up in the morning and Sleep at night. The current time is saved.' : 'Nothing logged for this day.';
  }
  paint();
  return section('moon', 'Sleep', null, h('div', { class: 'card sleep-card' }, h('div', { class: 'sleep-actions' }, wake.box, bed.box), summary));
}

/** Updates the screen straight away, then tells the sheet; reloads from the sheet if that fails. */
async function sendQuick(action, payload) {
  if (S.readOnly) return toast('This is a read-only view.', true);
  applyLocal(action, payload);
  S.countFns.forEach(f => f());
  if (S.demo) return;
  try { await api(action, payload); }
  catch (err) { toast(err.message, true); loadSheet({ quiet: true }); }
}
function drinkWater(date, ml) {
  const before = S.data.water.days[date]?.total || 0, goal = S.data.profile.waterGoal;
  sendQuick('addWater', { date, ml: Math.round(ml), time: nowHM() });
  if (before < goal && before + ml >= goal) toast('Daily water goal reached! 🎉');
}
function undoWater(date) { sendQuick('undoWater', { date }); }

/* ---------- height, water goal and tumbler setup ---------- */
function profileForm(onDone, onCancel) {
  const cur = S.data.profile || {}, last = store.get('profile', {});
  const val = k => cur[k] || last[k] || '';
  const num = (v, ph, extra = {}) => h('input', { type: 'number', inputmode: 'decimal', placeholder: ph, value: v, required: true, ...extra });
  const height = num(val('height'), 'e.g. 160', { min: '80', max: '250', step: '0.5' });
  const goal = num(val('waterGoal') || 2000, 'ml', { min: '500', max: '10000', step: '50' });
  const tumbler = num(val('tumbler') || 250, 'ml', { min: '50', max: '3000', step: '10' });
  const chips = (input, opts) => h('div', { class: 'chips' }, opts.map(([ml, lbl]) => h('button', { type: 'button', class: 'chip', onclick: () => { input.value = ml; sync(); } }, lbl)));
  const sync = () => $$('.chip', form).forEach(c => { const inp = c.parentNode.previousElementSibling; c.setAttribute('aria-pressed', String(inp && Number(inp.value) === Number(c.dataset.ml))); });
  const status = h('p', { class: 'sub err' });
  const form = h('form', {
    class: 'profile-form',
    onsubmit: async e => {
      e.preventDefault();
      const p = { height: Number(height.value), waterGoal: Number(goal.value), tumbler: Number(tumbler.value) };
      const btn = $('button[type=submit]', form);
      btn.disabled = true; status.textContent = '';
      try {
        await api('saveProfile', p);
        if (!S.demo) applyLocal('saveProfile', p);
        store.set('profile', p);
        toast('Saved');
        onDone();
      } catch (err) { status.textContent = err.message; btn.disabled = false; }
    }
  },
    h('label', null, 'Height (cm)', height),
    h('label', null, 'Daily water goal (ml)', goal, chips(goal, [[1500, '1.5 L'], [2000, '2 L'], [2500, '2.5 L'], [3000, '3 L']])),
    h('label', null, 'Tumbler size (ml)', tumbler, chips(tumbler, [[250, '250'], [350, '350'], [500, '500'], [750, '750'], [1000, '1 L']])),
    h('p', { class: 'sub' }, 'You can also add any custom amount while logging water.'),
    status,
    h('div', { class: 'row-actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save'), onCancel ? h('button', { class: 'btn ghost', type: 'button', onclick: onCancel }, 'Later') : null));
  $$('.chip', form).forEach(c => { c.dataset.ml = c.textContent.includes('L') ? parseFloat(c.textContent) * 1000 : c.textContent; });
  [height, goal, tumbler].forEach(i => i.addEventListener('input', sync));
  sync();
  return form;
}

function openProfileDialog() {
  if (S.readOnly) return toast('This is a read-only view.', true);
  const dlg = h('dialog', { class: 'modal' });
  const close = () => { dlg.close(); dlg.remove(); };
  const done = () => { close(); if (S.data) { renderAll(); renderProfileBox(); } };
  dlg.append(h('div', { class: 'card' }, h('h2', null, 'Set up body & water'),
    h('p', { class: 'sub' }, 'Height gives you BMI and a healthy weight range. The goal and tumbler power the water tracker.'),
    profileForm(done, close)));
  dlg.addEventListener('cancel', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

/** asks once per file when height / water goal / tumbler have never been set */
function maybePromptProfile() {
  const p = S.data.profile;
  if (S.readOnly || S.demo || (p.height && p.waterGoal && p.tumbler)) return;
  const key = `${S.viewUid}_${S.year}`;
  (S.profileAsked ||= new Set());
  if (S.profileAsked.has(key)) return;
  S.profileAsked.add(key);
  openProfileDialog();
}

function renderProfileBox() {
  const box = $('#profileBox');
  if (!box) return;
  if (!S.data) { fill(box, h('p', { class: 'sub' }, 'Load your sheet to edit these.')); return; }
  if (S.readOnly) {
    const p = S.data.profile;
    fill(box, h('p', { class: 'sub' }, `Height ${p.height || '—'} cm · Goal ${p.waterGoal || '—'} ml · Tumbler ${p.tumbler || '—'} ml`));
    return;
  }
  fill(box, profileForm(() => { renderProfileBox(); if (S.tab === 'log') renderLog(); }));
}

function buildProducts(date) {
  const ix = S.idx.products;
  const monthName = MONTHS[parseKey(date).getMonth()];
  const planned = new Set((S.data.sheets.buy?.months[monthName] || []).map(i => norm(i.product)));
  const all = () => [...ix.items, ...S.pending.newProducts.filter(n => !ix.items.some(i => norm(i) === norm(n)))];
  const lastBought = name => [...(ix.sets[name] || [])].filter(d => d < date).sort().pop();
  const grid = h('div', { class: 'tiles-grid' });
  let q = '';
  const draw = () => {
    const names = all();
    let show;
    if (q) show = names.filter(n => norm(n).includes(norm(q)));
    else {
      show = names.filter(n => planned.has(norm(n)) || currentGrid('products', n, date));
      if (!show.length) show = [...names].sort((a, b) => (ix.sets[b]?.size || 0) - (ix.sets[a]?.size || 0)).slice(0, 6);
    }
    show.sort((a, b) => (planned.has(norm(b)) - planned.has(norm(a))) || a.localeCompare(b));
    fill(grid, ...show.slice(0, 30).map(n => tapTile('products', n, date, { planned: planned.has(norm(n)), last: lastBought(n) })));
    if (!show.length) grid.append(h('p', { class: 'sub' }, `No product matches “${q}”. Add it below.`));
  };
  draw();
  const newInp = h('input', { placeholder: 'New product name' });
  const countFn = () => `${all().filter(n => currentGrid('products', n, date)).length} bought`;
  return section('shopping-bag', 'Bought today', countFn,
    h('p', { class: 'sub', style: 'margin:-4px 0 10px' }, planned.size ? `Showing this month's list. Search to find any product.` : 'Search to find any product.'),
    h('div', { class: 'search-row' },
      h('input', { class: 'search', type: 'search', placeholder: 'Search products', oninput: e => { q = e.target.value; draw(); } }),
      h('form', {
        onsubmit: e => {
          e.preventDefault();
          const n = newInp.value.trim(); if (!n) return;
          const existing = all().find(x => norm(x) === norm(n));
          if (!existing) S.pending.newProducts.push(n);
          setGrid('products', existing || n, date, true);
          newInp.value = ''; draw(); updateLogMeta();
        }
      }, newInp, h('button', { class: 'btn ghost' }, icon('plus'), 'Add'))),
    grid);
}

function buildWeek() {
  const start = mondayOf(S.logDate), t = todayKey();
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const cats = [['dos', 'Daily Dos'], ['habits', 'Habits'], ['products', 'Products'], ['period', 'Period']].filter(([k]) => S.idx[k]);
  if (!cats.some(([k]) => k === S.weekCat)) S.weekCat = cats[0]?.[0];
  const wrap = h('div', { class: 'card' });
  wrap.append(h('div', { class: 'week-cats' }, cats.map(([k, l]) => h('button', { class: 'chip', 'aria-pressed': String(S.weekCat === k), onclick: () => { S.weekCat = k; renderLog(); } }, l))));
  const grid = h('div', { class: 'wgrid' });
  grid.append(h('div'), ...days.map(d => h('div', { class: 'wh' + (d === t ? ' today' : '') }, DOW[dow(d)].slice(0, 2), h('br'), parseKey(d).getDate())));

  const cell = (getOn, setOn, isChanged, enabled, label, pink) => {
    const b = h('button', { class: 'wcell', disabled: !enabled, 'aria-label': label });
    if (pink) b.style.setProperty('--done', 'var(--pink)');
    const paint = () => { const on = getOn(); b.classList.toggle('on', on); b.classList.toggle('changed', isChanged()); b.setAttribute('aria-pressed', String(on)); fill(b, icon('check')); };
    b.addEventListener('click', () => { setOn(!getOn()); paint(); updateLogMeta(); });
    paint();
    return b;
  };
  const row = (k, name) => {
    grid.append(h('div', { class: 'wn', title: name }, icon(iconFor(name, k)), h('span', null, name)));
    days.forEach(d => grid.append(cell(() => currentGrid(k, name, d), on => setGrid(k, name, d, on), () => pkey(d, name) in S.pending.grid[k],
      S.idx[k].dateSet.has(d), `${name}, ${fmtLong(d)}`)));
  };

  const k = S.weekCat;
  if (k === 'dos') {
    for (const [g] of GROUPS) {
      const names = S.idx.dos.items.filter(n => groupOf(n) === g);
      if (!names.length) continue;
      grid.append(h('div', { class: 'wg' }, g));
      names.forEach(n => row('dos', n));
    }
  } else if (k === 'habits') S.idx.habits.items.forEach(n => row('habits', n));
  else if (k === 'products') {
    const ix = S.idx.products;
    const months = new Set(days.map(d => MONTHS[parseKey(d).getMonth()]));
    const planned = new Set([...months].flatMap(m => (S.data.sheets.buy?.months[m] || []).map(i => norm(i.product))));
    const active = ix.items.filter(n => planned.has(norm(n)) || days.some(d => currentGrid('products', n, d)));
    const rest = ix.items.filter(n => !active.includes(n));
    if (active.length) { grid.append(h('div', { class: 'wg' }, 'Planned or bought this week')); active.forEach(n => row('products', n)); }
    grid.append(h('div', { class: 'wg' }, 'All other products'));
    rest.forEach(n => row('products', n));
  } else if (k === 'period') {
    grid.append(h('div', { class: 'wn' }, icon('droplet'), h('span', null, 'Period day')));
    days.forEach(d => grid.append(cell(() => currentPeriod(d), on => setPeriod(d, on), () => d in S.pending.period,
      S.idx.period.dateSet.has(d), `Period, ${fmtLong(d)}`, true)));
  }
  wrap.append(h('div', { class: 'wscroll' }, grid));
  wrap.append(h('p', { class: 'sub', style: 'margin-top:12px' }, 'Tap circles to mark days. Changes across the week save together.'));
  return wrap;
}

function updateSaveBar() {
  const n = pendingCount();
  $('#saveBar').hidden = n === 0;
  const dcount = pendingDates().size;
  $('#pendingText').textContent = plural(n, 'change') + (dcount > 1 ? ` on ${dcount} days` : '');
}

async function saveAll() {
  if (S.readOnly) return toast('This is a read-only view.', true);
  const p = S.pending, days = {};
  const day = d => (days[d] ||= { date: d, grid: { products: {}, dos: {}, habits: {} } });
  for (const k of ['products', 'dos', 'habits']) {
    for (const [key, on] of Object.entries(p.grid[k])) day(key.slice(0, 10)).grid[k][key.slice(11)] = on;
  }
  for (const [d, on] of Object.entries(p.period)) day(d).period = on;
  for (const [d, w] of Object.entries(p.weight)) day(d).weight = Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v === '' ? '' : Number(v)]));
  const list = Object.values(days).sort((a, b) => a.date < b.date ? -1 : 1);
  const btn = $('#saveDayBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    try {
      await api('saveDays', { days: list });
    } catch (err) {
      // older deployed script without saveDays: save one day at a time
      if (!/unknown action/i.test(err.message)) throw err;
      for (const d of list) await api('saveDay', d);
    }
    if (!S.demo) applyLocal('saveDays', { days: list });
    S.pending = freshPending();
    buildIndex();
    renderLog();
    toast(list.length > 1 ? `Saved ${list.length} days` : 'Saved');
    if (!S.demo) loadSheet({ quiet: true });
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false; btn.textContent = 'Save to sheet';
  }
}

/* =========================================================
 * BUY LIST
 * ======================================================= */
function defaultBuyMonth() {
  const t = todayKey();
  if (t.slice(0, 4) === S.idx.year) return MONTHS[parseKey(t).getMonth()];
  const months = S.data.sheets.buy?.months || {};
  return MONTHS.find(m => (months[m] || []).length) || MONTHS[parseKey(S.idx.first).getMonth()];
}
function monthKey(monthName) { return `${S.idx.year}-${pad(MONTHS.indexOf(monthName) + 1)}`; }
function boughtInMonth(product, monthName) {
  const ix = S.idx.products;
  if (!ix) return null;
  const name = ix.items.find(i => norm(i) === norm(product));
  if (!name) return null;
  const ym = monthKey(monthName);
  return [...ix.sets[name]].filter(d => monthOf(d) === ym).sort()[0] || null;
}
function ensureDraft() {
  if (S.buyDraft && S.buyDraft.month === S.buyMonth) return;
  const items = (S.data.sheets.buy?.months[S.buyMonth] || []).map(i => ({ product: i.product, cost: i.cost ?? '' }));
  S.buyDraft = { month: S.buyMonth, items, budget: S.data.budgets?.[S.buyMonth] ?? '' };
  S.buyDirty = false;
}

function renderBuy() {
  if (!S.data.sheets.buy) { fill($('#tab-buy [data-ready]'), h('p', { class: 'empty' }, 'No "Month List To buy" sheet in this file.')); return; }
  ensureDraft();
  const months = S.data.sheets.buy.months;
  fill($('#monthChips'), ...MONTHS.map(m => h('button', {
    class: 'chip', 'aria-pressed': String(m === S.buyMonth),
    onclick: () => {
      if (S.buyDirty && !confirm('Discard unsaved changes to ' + S.buyMonth + '?')) return;
      S.buyMonth = m; S.buyDraft = null; renderBuy();
    }
  }, m.slice(0, 3), (months[m] || []).length ? h('span', { class: 'dot', 'aria-label': 'has items' }) : null)));
  $('#buyMonthTitle').textContent = `${S.buyMonth} ${S.idx.year}`;
  const bi = $('#budgetInput');
  bi.value = S.buyDraft.budget;
  bi.oninput = () => { S.buyDraft.budget = bi.value; markBuyDirty(); renderBuySummary(); };
  fill($('#productNames'), ...(S.idx.products?.items || []).map(n => h('option', { value: n })));
  const rows = $('#buyRows');
  fill(rows, ...S.buyDraft.items.map((it, i) => buyRow(it, i)));
  if (!S.buyDraft.items.length) rows.append(h('div', { class: 'empty-row' }, `Nothing planned for ${S.buyMonth} yet. Add a product below.`));
  $('#buyDirty').hidden = !S.buyDirty;
  renderBuySummary();
}

function buyRow(it, i) {
  const statusCell = h('div', { class: 'status' });
  const bic = h('div', { class: 'bic' }, icon(iconFor(it.product, 'products')));
  const rowEl = h('div', { class: 'buy-row' });
  const drawStatus = () => {
    fill(statusCell, );
    fill(bic, icon(iconFor(it.product, 'products')));
    rowEl.classList.remove('bought');
    if (!it.product.trim()) return;
    const b = boughtInMonth(it.product, S.buyMonth);
    const known = S.idx.products?.items.some(n => norm(n) === norm(it.product));
    if (b) {
      rowEl.classList.add('bought');
      statusCell.className = 'status bought';
      statusCell.append(icon('circle-check'), 'Bought ' + fmt(b), h('button', { class: 'btn small ghost', onclick: () => doMarkBought(it.product, b, false) }, 'Undo'));
      return;
    }
    statusCell.className = 'status';
    const t = todayKey(), ym = monthKey(S.buyMonth);
    const def = monthOf(t) === ym ? t : clampDate(`${ym}-01`);
    const di = h('input', { type: 'date', value: def, min: S.idx.first, max: S.idx.last, 'aria-label': 'Bought on' });
    statusCell.append(h('div', { class: 'buy-bought-form' }, di, h('button', { class: 'btn small', onclick: () => doMarkBought(it.product, di.value, true) }, icon('check'), 'Bought')));
    if (!known) statusCell.append(h('div', { class: 'new-tag' }, 'New — will be added to Products'));
  };
  rowEl.append(bic,
    h('input', { class: 'p', list: 'productNames', value: it.product, placeholder: 'Product', 'aria-label': `Product ${i + 1}`, oninput: e => { it.product = e.target.value; markBuyDirty(); drawStatus(); renderBuySummary(); } }),
    h('input', { class: 'c', type: 'number', min: '0', step: '1', inputmode: 'numeric', value: it.cost, placeholder: '₹', 'aria-label': 'Approx cost', oninput: e => { it.cost = e.target.value; markBuyDirty(); renderBuySummary(); } }),
    statusCell,
    h('button', { class: 'remove', 'aria-label': 'Remove', onclick: () => { S.buyDraft.items.splice(i, 1); markBuyDirty(); renderBuy(); } }, icon('x')));
  drawStatus();
  return rowEl;
}

function markBuyDirty() { S.buyDirty = true; $('#buyDirty').hidden = false; }

async function doMarkBought(product, date, bought) {
  if (S.readOnly) return toast('This is a read-only view.', true);
  if (!date) return toast('Pick the date you bought it.', true);
  try {
    await api('markBought', { product, date, bought });
    if (!S.demo) applyLocal('markBought', { product, date, bought });
    buildIndex();
    renderBuy();
    toast(bought ? `${product} marked bought on ${fmt(date)}` : 'Undone');
  } catch (err) { toast(err.message, true); }
}

async function saveBuy() {
  if (S.readOnly) return toast('This is a read-only view.', true);
  const d = S.buyDraft;
  const items = d.items.filter(i => i.product.trim()).map(i => ({ product: i.product.trim(), cost: i.cost === '' ? '' : Number(i.cost) }));
  const payload = { month: d.month, items, budget: d.budget === '' ? '' : Number(d.budget) };
  const btn = $('#saveBuyBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await api('saveBuyList', payload);
    if (!S.demo) applyLocal('saveBuyList', payload);
    S.buyDraft = null;
    buildIndex();
    renderBuy();
    toast(`${d.month} list saved`);
  } catch (err) { toast(err.message, true); }
  finally { btn.disabled = false; btn.textContent = 'Save list'; }
}

function renderBuySummary() {
  const d = S.buyDraft;
  const items = d.items.filter(i => i.product.trim());
  const total = items.reduce((s, i) => s + (Number(i.cost) || 0), 0);
  const boughtItems = items.filter(i => boughtInMonth(i.product, d.month));
  const boughtVal = boughtItems.reduce((s, i) => s + (Number(i.cost) || 0), 0);
  const budget = d.budget === '' ? null : Number(d.budget);
  const used = budget ? total / budget : 0;
  const over = budget !== null && total > budget;
  const mi = MONTHS.indexOf(d.month), carry = [], months = S.data.sheets.buy.months;
  for (let m = 0; m < mi; m++) {
    for (const it of months[MONTHS[m]] || []) {
      const ix = S.idx.products;
      const name = ix?.items.find(n => norm(n) === norm(it.product));
      const since = `${S.idx.year}-${pad(m + 1)}-01`;
      const everBought = name && [...ix.sets[name]].some(x => x >= since);
      if (!everBought && !items.some(i => norm(i.product) === norm(it.product)) && !carry.some(c => norm(c.product) === norm(it.product))) carry.push({ ...it, from: MONTHS[m] });
    }
  }
  fill($('#buySummary'), ...[
    h('h2', null, 'Summary'),
    budget !== null ? h('div', null,
      h('div', { class: 'meter' + (over ? ' over' : '') }, h('span', { style: `width:${Math.min(100, used * 100).toFixed(1)}%` })),
      h('p', { class: 'sub' + (over ? ' down' : '') }, over ? `Over budget by ${rupee(total - budget)}` : `${pct(used)} of budget planned · ${rupee(budget - total)} left`)
    ) : h('p', { class: 'sub' }, 'Set a budget to track it.'),
    h('div', { class: 'kv' }, h('span', null, 'Planned items'), h('b', null, items.length)),
    h('div', { class: 'kv' }, h('span', null, 'Planned total'), h('b', null, rupee(total))),
    h('div', { class: 'kv' }, h('span', null, 'Budget'), h('b', null, rupee(budget))),
    h('div', { class: 'kv' }, h('span', null, `Bought (${boughtItems.length}/${items.length})`), h('b', null, rupee(boughtVal))),
    h('div', { class: 'kv' }, h('span', null, 'Still to buy'), h('b', null, rupee(total - boughtVal))),
    carry.length ? h('div', { style: 'margin-top:18px' },
      h('h3', null, 'Not bought from earlier months'),
      h('ul', { class: 'insights', style: 'margin-top:10px' }, carry.slice(0, 8).map(c => h('li', { style: 'align-items:center' },
        h('span', { class: 'ico' }, icon(iconFor(c.product, 'products'))),
        h('span', { style: 'flex:1;padding:0' }, c.product, h('span', { class: 'muted' }, ` · ${c.from.slice(0, 3)}${c.cost ? ' · ' + rupee(c.cost) : ''}`)),
        h('button', { class: 'btn small ghost', onclick: () => { S.buyDraft.items.push({ product: c.product, cost: c.cost ?? '' }); markBuyDirty(); renderBuy(); } }, icon('plus'), 'Add')
      )))) : null
  ].filter(Boolean));
}

/* =========================================================
 * SETTINGS — groups editor & theme
 * ======================================================= */
function renderGroupEditor() {
  const box = $('#groupEditor');
  if (!S.idx?.dos) return;
  const groups = store.get('groups', {});
  fill(box, ...S.idx.dos.items.map(n => h('div', { class: 'group-row' }, icon(iconFor(n, 'dos')), h('span', null, n),
    h('select', {
      'aria-label': `Group for ${n}`, onchange: e => {
        const g = store.get('groups', {});
        if (e.target.value === autoGroup(n)) delete g[n]; else g[n] = e.target.value;
        store.set('groups', g);
      }
    }, GROUPS.map(([g]) => { const o = h('option', { value: g }, g); if ((groups[n] || autoGroup(n)) === g) o.selected = true; return o; })))));
}

const THEMES = ['auto', 'light', 'dark'];
function applyTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  $$('[data-theme-label]').forEach(e => { e.textContent = 'Theme: ' + t; });
  store.set('theme', t === 'auto' ? null : t);
}

/* =========================================================
 * ANALYSIS ENGINE
 * ======================================================= */
function analysisWindow() {
  const t = todayKey();
  const last = S.idx.last < t ? S.idx.last : t;
  const first = S.idx.first;
  const r = S.range;
  if (r === 'last7') return [addDays(last, -6) < first ? first : addDays(last, -6), last];
  if (r === 'last30') return [addDays(last, -29) < first ? first : addDays(last, -29), last];
  if (/^\d{4}-\d{2}$/.test(r)) {
    const s = r + '-01';
    const e = keyOf(new Date(Number(r.slice(0, 4)), Number(r.slice(5)), 0));
    return [s < first ? first : s, e > last ? last : e];
  }
  return [first, last];
}

function previousWindow([s, e]) {
  const len = diffDays(s, e) + 1;
  return [addDays(s, -len), addDays(s, -1)];
}

function analyzeGrid(k, [start, end]) {
  const ix = S.idx[k];
  if (!ix) return null;
  const days = ix.dates.filter(d => d >= start && d <= end);
  const logged = days.filter(d => ix.loggedDays.has(d));
  const nItems = ix.items.length;
  const score = logged.map(d => ix.items.filter(n => ix.sets[n].has(d)).length / nItems);

  const items = ix.items.map(name => {
    const set = ix.sets[name];
    const done = logged.filter(d => set.has(d));
    // streaks inside window, consecutive calendar days
    let longest = 0, run = 0;
    for (const d of days) { if (set.has(d)) { run++; longest = Math.max(longest, run); } else run = 0; }
    const t = todayKey();
    const anchor = set.has(end) ? end : (end === t ? addDays(end, -1) : end);
    const current = streakEnding(set, anchor);
    const byDow = Array.from({ length: 7 }, (_, w) => {
      const ld = logged.filter(d => dow(d) === w);
      return ld.length ? ld.filter(d => set.has(d)).length / ld.length : null;
    });
    const half = Math.floor(logged.length / 2);
    const a = logged.slice(0, half), b = logged.slice(half);
    const trend = (a.length >= 3 && b.length >= 3) ? (b.filter(d => set.has(d)).length / b.length) - (a.filter(d => set.has(d)).length / a.length) : null;
    const lastDone = [...set].filter(d => d <= end).sort().pop() || null;
    return { name, done: done.length, rate: logged.length ? done.length / logged.length : null, longest, current, byDow, trend, lastDone };
  });

  // keystone: other items' completion on days this item is done vs not
  for (const it of items) {
    const set = ix.sets[it.name];
    const others = ix.items.filter(n => n !== it.name);
    const on = [], off = [];
    for (const d of logged) {
      const sc = others.filter(n => ix.sets[n].has(d)).length / Math.max(1, others.length);
      (set.has(d) ? on : off).push(sc);
    }
    it.lift = (on.length >= 3 && off.length >= 3) ? mean(on) - mean(off) : null;
  }

  const dowAvg = Array.from({ length: 7 }, (_, w) => {
    const idx = logged.map((d, i) => dow(d) === w ? score[i] : null).filter(x => x !== null);
    return idx.length ? mean(idx) : null;
  });
  return { k, days, logged, unlogged: days.length - logged.length, score, items, dowAvg, avg: mean(score) };
}

function rolling(arr, n) {
  return arr.map((_, i) => { const s = arr.slice(Math.max(0, i - n + 1), i + 1).filter(x => x !== null); return s.length ? mean(s) : null; });
}

/* ---------- period ---------- */
function analyzePeriod() {
  if (!S.idx.period) return { periods: [], spotting: [], cycles: [] };
  const marks = [...S.idx.period.marked].sort();
  const runs = [];
  for (const d of marks) {
    const r = runs[runs.length - 1];
    if (r && diffDays(r.end, d) <= 2) r.end = d, r.days.push(d);
    else runs.push({ start: d, end: d, days: [d] });
  }
  const periods = [], spotting = [];
  for (const r of runs) {
    const prev = periods[periods.length - 1];
    if (prev && diffDays(prev.start, r.start) < 15) spotting.push(r);
    else periods.push(r);
  }
  periods.forEach(p => { p.length = diffDays(p.start, p.end) + 1; });
  const cycles = periods.slice(1).map((p, i) => ({ from: periods[i].start, to: p.start, length: diffDays(periods[i].start, p.start) }));
  const cl = cycles.map(c => c.length);
  const avgCycle = cl.length ? mean(cl) : null;
  const usedCycle = Math.round(avgCycle || 28);
  const variation = cl.length >= 2 ? Math.max(...cl) - Math.min(...cl) : null;
  const spread = cl.length >= 2 ? Math.max(2, Math.round(sd(cl))) : 3;
  const avgLen = periods.length ? mean(periods.map(p => p.length)) : null;
  const last = periods[periods.length - 1];
  const t = todayKey();
  let next = null, nextList = [], ovulation = null, fertile = null, late = null;
  if (last) {
    next = addDays(last.start, usedCycle);
    // if the expected date has passed with no new period, keep the date but flag it late
    if (t > addDays(next, 2)) late = diffDays(next, t);
    for (let i = 0; i < 3; i++) nextList.push(addDays(last.start, usedCycle * (i + 1)));
    ovulation = addDays(next, -14);
    fertile = [addDays(ovulation, -5), addDays(ovulation, 1)];
  }
  const flags = [];
  if (cl.some(c => c < 21)) flags.push('A cycle shorter than 21 days was recorded.');
  if (cl.some(c => c > 35)) flags.push('A cycle longer than 35 days was recorded.');
  if (periods.some(p => p.length > 7)) flags.push('A period lasted more than 7 days.');
  if (variation !== null && variation > 7) flags.push(`Cycle length varies by ${variation} days — that counts as irregular.`);
  if (spotting.length) flags.push(`${plural(spotting.length, 'short bleed')} between periods logged (treated as spotting, not a new cycle).`);
  return { periods, spotting, cycles, avgCycle, usedCycle, variation, spread, avgLen, next, nextList, ovulation, fertile, late, flags, estimated: !avgCycle };
}

function cycleDayOn(P, date) {
  const start = [...P.periods].reverse().find(p => p.start <= date);
  if (!start) return null;
  const day = diffDays(start.start, date) + 1;
  const len = P.usedCycle;
  let phase;
  if (date <= start.end) phase = 'Menstrual';
  else if (day <= len - 16) phase = 'Follicular';
  else if (day <= len - 12) phase = 'Ovulation window';
  else phase = 'Luteal';
  if (day > len + 7) phase = 'Beyond expected cycle';
  return { day, phase };
}

/* ---------- weight ---------- */
function analyzeWeight([start, end]) {
  const iw = S.idx.weight;
  if (!iw) return null;
  const all = Object.entries(iw.entries).sort(([a], [b]) => a < b ? -1 : 1);
  const pts = all.filter(([d]) => d >= start && d <= end);
  if (!pts.length) return { n: 0, all };
  const ws = pts.map(p => p[1]);
  const first = pts[0], latest = pts[pts.length - 1];
  const minP = pts.reduce((a, b) => b[1] < a[1] ? b : a), maxP = pts.reduce((a, b) => b[1] > a[1] ? b : a);
  // least-squares slope (kg/day)
  let slope = null;
  if (pts.length >= 3) {
    const xs = pts.map(p => diffDays(first[0], p[0]));
    const mx = mean(xs), my = mean(ws);
    const num = xs.reduce((s, x, i) => s + (x - mx) * (ws[i] - my), 0);
    const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    slope = den ? num / den : null;
  }
  const ma7 = pts.map(([d]) => mean(pts.filter(([x]) => x <= d && diffDays(x, d) < 7).map(p => p[1])));
  const span = diffDays(first[0], latest[0]) + 1;

  // next-day change after doing each item
  const deltas = [];
  for (let i = 0; i < all.length - 1; i++) {
    if (diffDays(all[i][0], all[i + 1][0]) === 1 && all[i][0] >= start && all[i][0] <= end) deltas.push({ d: all[i][0], delta: all[i + 1][1] - all[i][1] });
  }

  // morning = before breakfast, night = after dinner:
  //   gain = morning → same night (what the day adds), drop = night → next morning (what sleep takes off)
  const nt = iw.night || {};
  const dow = d => parseKey(d).getDay();
  const dayRows = pts.filter(([d]) => nt[d] !== undefined).map(([d, m]) => ({ d, gain: nt[d] - m, dow: dow(d) }));
  const nightRows = Object.keys(nt).filter(d => d >= start && d <= end && iw.entries[addDays(d, 1)] !== undefined).sort()
    .map(d => ({ d, drop: iw.entries[addDays(d, 1)] - nt[d], dow: dow(d) }));
  const cycles = dayRows.filter(r => iw.entries[addDays(r.d, 1)] !== undefined)
    .map(r => { const drop = iw.entries[addDays(r.d, 1)] - nt[r.d]; return { d: r.d, gain: r.gain, drop, net: r.gain + drop }; });
  const nightPts = Object.keys(nt).filter(d => d >= start && d <= end).sort().map(d => [d, nt[d]]);
  let nightSlope = null;
  if (nightPts.length >= 3) {
    const xs = nightPts.map(p => diffDays(nightPts[0][0], p[0])), ys = nightPts.map(p => p[1]);
    const mx = mean(xs), my = mean(ys);
    const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    nightSlope = den ? xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / den : null;
  }
  const rhythm = {
    pairs: dayRows.length, nights: nightRows.length, cycles,
    gainAvg: dayRows.length ? mean(dayRows.map(r => r.gain)) : null,
    dropAvg: nightRows.length ? mean(nightRows.map(r => r.drop)) : null,
    netAvg: cycles.length ? mean(cycles.map(r => r.net)) : null,
    nightAvg: nightPts.length ? mean(nightPts.map(p => p[1])) : null,
    nightSlope, nightN: nightPts.length,
    maxGain: dayRows.length ? dayRows.reduce((a, b) => (b.gain > a.gain ? b : a)) : null,
    minGain: dayRows.length ? dayRows.reduce((a, b) => (b.gain < a.gain ? b : a)) : null,
    morningOnly: pts.filter(([d]) => nt[d] === undefined).length,
    nightOnly: nightPts.filter(([d]) => iw.entries[d] === undefined).length,
    byDow: DOW.map((_, i) => ({ gain: mean(dayRows.filter(r => r.dow === i).map(r => r.gain)), drop: mean(nightRows.filter(r => r.dow === i).map(r => r.drop)), n: dayRows.filter(r => r.dow === i).length }))
  };
  // share of the day's gain that sleep takes back (only over complete morning → night → morning cycles)
  const cg = cycles.length ? mean(cycles.map(r => r.gain)) : null;
  rhythm.recovery = cg !== null && cg > 0.1 ? -mean(cycles.map(r => r.drop)) / cg : null;

  // does doing an item go with a bigger day gain, a bigger overnight drop, or a different next morning?
  const metrics = {
    day: dayRows.map(r => ({ d: r.d, v: r.gain })),
    over: nightRows.map(r => ({ d: r.d, v: r.drop })),
    next: deltas.map(x => ({ d: x.d, v: x.delta }))
  };
  const effects = [];
  for (const k of ['dos', 'habits']) {
    const ix = S.idx[k];
    if (!ix) continue;
    for (const name of ix.items) {
      const e = { name, sheet: k };
      let best = 0;
      for (const [mk, rows] of Object.entries(metrics)) {
        const on = rows.filter(x => ix.loggedDays.has(x.d) && ix.sets[name].has(x.d)).map(x => x.v);
        const off = rows.filter(x => ix.loggedDays.has(x.d) && !ix.sets[name].has(x.d)).map(x => x.v);
        if (on.length >= 3 && off.length >= 3) { e[mk] = { on: mean(on), off: mean(off), diff: mean(on) - mean(off) }; best = Math.max(best, Math.abs(e[mk].diff)); }
      }
      if (best) { e.best = best; effects.push(e); }
    }
  }
  effects.sort((a, b) => b.best - a.best);
  return { n: pts.length, pts, all, first, latest, minP, maxP, avg: mean(ws), slope, ma7, span, deltas, effects, rhythm, nightPts };
}

/* ---------- spending ---------- */
function analyzeSpending() {
  const buy = S.data.sheets.buy;
  const ix = S.idx.products;
  const months = MONTHS.map(m => {
    const items = buy?.months[m] || [];
    const planned = items.reduce((s, i) => s + (i.cost || 0), 0);
    const bought = items.filter(i => boughtInMonth(i.product, m));
    const boughtVal = bought.reduce((s, i) => s + (i.cost || 0), 0);
    const ym = monthKey(m);
    const plannedNames = new Set(items.map(i => norm(i.product)));
    const unplanned = ix ? ix.items.filter(n => [...ix.sets[n]].some(d => monthOf(d) === ym) && !plannedNames.has(norm(n))) : [];
    return { m, items, planned, boughtCount: bought.length, boughtVal, budget: S.data.budgets?.[m] ?? null, unplanned };
  });
  const t = todayKey();
  const restock = ix ? ix.items.map(name => {
    const ds = [...ix.sets[name]].sort();
    const gaps = ds.slice(1).map((d, i) => diffDays(ds[i], d));
    const interval = gaps.length ? mean(gaps) : null;
    const lastD = ds[ds.length - 1] || null;
    const nextD = lastD && interval ? addDays(lastD, Math.round(interval)) : null;
    let status = 'never';
    if (ds.length === 1) status = 'once';
    if (nextD) {
      const dd = diffDays(t, nextD);
      status = dd < 0 ? 'overdue' : dd <= 7 ? 'soon' : 'ok';
    }
    return { name, count: ds.length, interval, last: lastD, next: nextD, status };
  }) : [];
  const repeatPlanned = {};
  months.forEach(mo => mo.items.forEach(i => { const n = norm(i.product); (repeatPlanned[n] ||= { name: i.product, months: [] }).months.push(mo.m.slice(0, 3)); }));
  const allPlanned = months.flatMap(mo => mo.items.map(i => ({ ...i, m: mo.m })));
  return {
    months, restock,
    repeat: Object.values(repeatPlanned).filter(r => r.months.length >= 2),
    priciest: allPlanned.filter(i => i.cost).sort((a, b) => b.cost - a.cost).slice(0, 6),
    yearPlanned: months.reduce((s, m) => s + m.planned, 0),
    yearBudget: months.reduce((s, m) => s + (m.budget || 0), 0),
    yearBought: months.reduce((s, m) => s + m.boughtVal, 0)
  };
}

/* =========================================================
 * ANALYSIS RENDERING
 * ======================================================= */
const VIEWS = [
  ['overview', 'Overview'], ['dos', 'Daily Dos'], ['habits', 'Habits'],
  ['period', 'Period cycle'], ['weight', 'Weight'], ['sleep', 'Sleep'], ['spending', 'Spending & restock']
];

const views = () => VIEWS.filter(([v]) => !(v === 'period' && hidesPeriod()));

function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function destroyCharts() { S.charts.forEach(c => c.destroy()); S.charts = []; }

function chart(canvas, config) {
  if (!window.Chart) { canvas.replaceWith(h('p', { class: 'muted' }, 'Charts are loading…')); return; }
  const ink2 = css('--ink-2'), line = css('--line');
  Chart.defaults.font.family = css('--font') || 'sans-serif';
  Chart.defaults.color = ink2;
  config.options = Object.assign({
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { boxWidth: 12, boxHeight: 12, usePointStyle: true } } }
  }, config.options || {});
  const sc = config.options.scales || {};
  for (const ax of Object.values(sc)) {
    ax.grid = Object.assign({ color: line, drawTicks: false }, ax.grid || {});
    ax.border = { display: false };
    ax.ticks = Object.assign({ padding: 6 }, ax.ticks || {});
  }
  S.charts.push(new Chart(canvas, config));
}

function renderAnalysis() {
  destroyCharts();
  // range options
  const sel = $('#rangeSelect');
  const ms = [...new Set(rangeDays(S.idx.first, S.idx.last).map(monthOf))];
  const opts = [['all', 'All tracked'], ['last30', 'Last 30 days'], ['last7', 'Last 7 days'], ...ms.map(m => [m, monthLabel(m)])];
  fill(sel, ...opts.map(([v, l]) => h('option', { value: v }, l)));
  sel.value = S.range;
  sel.onchange = () => { S.range = sel.value; renderAnalysis(); };
  if (!views().some(([v]) => v === S.view)) S.view = 'overview';
  fill($('#analysisPills'), ...views().map(([v, l]) => h('button', { class: 'chip', 'aria-pressed': String(S.view === v), onclick: () => { S.view = v; renderAnalysis(); } }, l)));

  const body = $('#analysisBody');
  fill(body, );
  const win = analysisWindow();
  $('#analysisSub').textContent = windowLabel(win);
  const fn = { overview: viewOverview, dos: (w, b) => viewGrid('dos', w, b), habits: (w, b) => viewGrid('habits', w, b), period: viewPeriod, weight: viewWeight, sleep: viewSleep, spending: viewSpending }[S.view];
  fn(win, body);
}

function tile(k, v, s, cls) {
  return h('div', { class: 'tile' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), s ? h('div', { class: 's ' + (cls || '') }, s) : null);
}
function deltaText(cur, prev, unit = 'pts') {
  if (cur === null || prev === null || cur === undefined || prev === undefined) return null;
  const d = (cur - prev) * 100;
  if (Math.abs(d) < 0.5) return ['≈ same as previous period', ''];
  return [`${d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(0)} ${unit} vs previous period`, d > 0 ? 'up' : 'down'];
}
const INSIGHT_ICONS = {
  '🏆': ['trophy'], '💤': ['zzz', 'warn'], '📈': ['trending-up'], '📉': ['trending-down', 'bad'], '🔑': ['key'], '📝': ['pencil', 'warn'],
  '🩸': ['droplet', 'pink'], '⚠️': ['alert-triangle', 'warn'], '🛒': ['shopping-cart'], '⚖️': ['scale'], '✨': ['sparkles'], '📅': ['calendar'],
  '🌸': ['flower', 'pink'], '🔻': ['arrow-down', 'bad'], '🔺': ['arrow-up'], 'ℹ️': ['info-circle'], '🔴': ['alert-circle', 'bad'],
  '✅': ['circle-check'], '🟡': ['clock', 'warn'], '🛍️': ['shopping-bag', 'warn'], '🔁': ['repeat'], '💸': ['cash']
};
function insightList(items) {
  return h('ul', { class: 'insights' }, items.filter(Boolean).map(([ico, text]) => {
    const [name, tone] = INSIGHT_ICONS[ico] || ['point'];
    return h('li', null, h('span', { class: 'ico ' + (tone || '') }, icon(name)), h('span', null, text));
  }));
}
function windowLabel([s, e]) { return `${fmt(s)} – ${fmt(e)}`; }

/* ---------- overview ---------- */
function viewOverview(win, body) {
  const D = analyzeGrid('dos', win), H = analyzeGrid('habits', win);
  const pw = previousWindow(win);
  const Dp = analyzeGrid('dos', pw), Hp = analyzeGrid('habits', pw);
  const P = analyzePeriod(), W = analyzeWeight(win), $p = analyzeSpending();
  const t = todayKey();
  const allStreaks = [...(D?.items || []), ...(H?.items || [])].sort((a, b) => b.current - a.current);
  const top = allStreaks[0];
  const curMonth = MONTHS[parseKey(t).getMonth()];
  const cm = $p.months.find(m => m.m === curMonth);

  const tiles = h('div', { class: 'tiles' });
  if (D) { const dt = deltaText(D.avg, Dp?.avg); tiles.append(tile('Daily Dos completion', pct(D.avg), dt?.[0] || `${D.logged.length} logged days`, dt?.[1])); }
  if (H) { const dt = deltaText(H.avg, Hp?.avg); tiles.append(tile('Habits completion', pct(H.avg), dt?.[0] || `${H.logged.length} logged days`, dt?.[1])); }
  if (top) tiles.append(tile('Best running streak', top.current ? `${top.current} days` : '—', top.current ? top.name : 'No active streak'));
  if (P.next) tiles.append(tile('Next period', fmt(P.next), P.late ? `Late by ${plural(P.late, 'day')}` : `in ${plural(Math.max(0, diffDays(t, P.next)), 'day')}${P.estimated ? ' · estimate' : ''}`, P.late ? 'down' : ''));
  if (W && W.n) tiles.append(tile('Weight', `${W.latest[1]} kg`, W.n > 1 ? `${W.latest[1] - W.first[1] >= 0 ? '+' : ''}${(W.latest[1] - W.first[1]).toFixed(1)} kg since ${fmt(W.first[0])}` : 'First weigh-in'));
  else if (W) tiles.append(tile('Weight', '—', 'No weigh-ins in this period'));
  if (W && W.n && S.data.profile?.height) { const b = bmiInfo(W.latest[1], S.data.profile.height); tiles.append(tile('BMI', b.bmi.toFixed(1), b.label, b.cls === 'good' ? 'up' : 'down')); }
  const Sl = analyzeSleep(win);
  if (Sl.n) tiles.append(tile('Average sleep', durText(Math.round(Sl.avg)), Sl.inRange !== null ? `${pct(Sl.inRange)} of nights in the 7–9 h range` : `${plural(Sl.n, 'night')} logged`, Sl.avg >= 420 && Sl.avg <= 540 ? 'up' : 'down'));
  if (cm) tiles.append(tile(`${curMonth} buy list`, rupee(cm.planned), cm.budget ? `of ${rupee(cm.budget)} budget · ${cm.boughtCount}/${cm.items.length} bought` : `${cm.boughtCount}/${cm.items.length} bought`));
  body.append(tiles);

  // combined insights
  const ins = [];
  const both = [...(D?.items || []), ...(H?.items || [])].filter(i => i.rate !== null);
  const best = [...both].sort((a, b) => b.rate - a.rate).slice(0, 3);
  if (best.length) ins.push(['🏆', `Most consistent: ${best.map(i => `${i.name} (${pct(i.rate)})`).join(', ')}.`]);
  const never = both.filter(i => i.done === 0).map(i => i.name);
  if (never.length) ins.push(['💤', `Not done even once in this period: ${never.slice(0, 6).join(', ')}${never.length > 6 ? '…' : ''}.`]);
  const improving = both.filter(i => i.trend !== null && i.trend >= 0.15).sort((a, b) => b.trend - a.trend);
  if (improving.length) ins.push(['📈', `Picking up lately: ${improving.slice(0, 3).map(i => `${i.name} (+${(i.trend * 100).toFixed(0)} pts)`).join(', ')}.`]);
  const slipping = both.filter(i => i.trend !== null && i.trend <= -0.15).sort((a, b) => a.trend - b.trend);
  if (slipping.length) ins.push(['📉', `Slipping lately: ${slipping.slice(0, 3).map(i => `${i.name} (${(i.trend * 100).toFixed(0)} pts)`).join(', ')}.`]);
  const ks = (D?.items || []).filter(i => i.lift !== null && i.lift > 0.1).sort((a, b) => b.lift - a.lift)[0];
  if (ks) ins.push(['🔑', `Keystone: on days you do “${ks.name}”, you complete ${(ks.lift * 100).toFixed(0)} pts more of your other Daily Dos.`]);
  if (D && D.unlogged) ins.push(['📝', `${plural(D.unlogged, 'day')} in this period have nothing ticked in Daily Dos — they may just be unlogged.`]);
  if (P.late) ins.push(['🩸', `Period expected ${fmt(P.next)} — now ${plural(P.late, 'day')} late.`]);
  P.flags.slice(0, 2).forEach(f => ins.push(['⚠️', f]));
  const due = analyzeSpending().restock.filter(r => r.status === 'overdue' || r.status === 'soon');
  if (due.length) ins.push(['🛒', `Restock due: ${due.slice(0, 5).map(r => r.name).join(', ')}.`]);
  if (W && W.n && S.data.profile?.height) { const b = bmiInfo(W.latest[1], S.data.profile.height); if (b.cls !== 'good') ins.push(['⚠️', `BMI ${b.bmi.toFixed(1)} (${b.label.toLowerCase()}). ${b.advice} Healthy range: ${b.lo}–${b.hi} kg.`]); }
  if (W && W.slope !== null) ins.push(['⚖️', `Weight trend: ${W.slope * 7 >= 0 ? '+' : ''}${(W.slope * 7).toFixed(2)} kg per week over ${plural(W.n, 'weigh-in')}.`]);

  const g = h('div', { class: 'grid-2' });
  g.append(h('div', { class: 'card' }, h('h2', null, 'What stands out'), h('p', { class: 'sub' }, windowLabel(win)), h('div', { style: 'margin-top:12px' }, ins.length ? insightList(ins) : h('p', { class: 'muted' }, 'Log a few more days to see insights.'))));
  const cv = h('canvas');
  g.append(h('div', { class: 'card' }, h('h2', null, 'Daily completion'), h('p', { class: 'sub' }, 'Share of items ticked on each logged day'), h('div', { class: 'chart-box' }, cv)));
  body.append(g);

  const labels = [...new Set([...(D?.logged || []), ...(H?.logged || [])])].sort();
  const ser = (A) => labels.map(d => { const i = A?.logged.indexOf(d); return i >= 0 ? Math.round(A.score[i] * 100) : null; });
  const ds = [];
  if (D) ds.push({ label: 'Daily Dos', data: ser(D), borderColor: css('--accent'), backgroundColor: css('--accent'), borderWidth: 2, pointRadius: 3, spanGaps: true, tension: .25 });
  if (H) ds.push({ label: 'Habits', data: ser(H), borderColor: css('--orange'), backgroundColor: css('--orange'), borderWidth: 2, pointRadius: 3, spanGaps: true, tension: .25 });
  chart(cv, { type: 'line', data: { labels: labels.map(d => fmt(d)), datasets: ds }, options: { scales: { y: { min: 0, max: 100, ticks: { callback: v => v + '%' } }, x: { grid: { display: false } } } } });
}

/* ---------- daily dos / habits ---------- */
function viewGrid(k, win, body) {
  const A = analyzeGrid(k, win);
  const title = k === 'dos' ? 'Daily Dos' : 'Habits';
  if (!A) { body.append(h('p', { class: 'empty' }, `No ${title} sheet found.`)); return; }
  if (!A.logged.length) { body.append(h('p', { class: 'empty' }, `Nothing ticked in ${title} for ${windowLabel(win)}.`)); return; }
  const Ap = analyzeGrid(k, previousWindow(win));
  const perfect = A.score.filter(s => s === 1).length;
  const best = [...A.items].sort((a, b) => b.longest - a.longest)[0];
  const dt = deltaText(A.avg, Ap?.avg);
  const validDow = A.dowAvg.map((v, i) => [v, i]).filter(([v]) => v !== null);
  const bestDow = validDow.sort((a, b) => b[0] - a[0])[0];
  const worstDow = validDow.sort((a, b) => a[0] - b[0])[0];

  body.append(h('div', { class: 'tiles' },
    tile('Average completion', pct(A.avg), dt?.[0], dt?.[1]),
    tile('Logged days', `${A.logged.length}/${A.days.length}`, A.unlogged ? `${A.unlogged} with nothing ticked` : 'Every day logged'),
    tile('100% days', perfect, perfect ? 'Every item ticked' : 'No perfect days yet'),
    tile('Longest streak', best.longest ? `${best.longest} days` : '—', best.longest ? best.name : ''),
    bestDow ? tile('Strongest day', DOW[bestDow[1]], `${pct(bestDow[0])} avg · weakest ${DOW[worstDow[1]]} ${pct(worstDow[0])}`) : null
  ));

  // charts
  const c1 = h('canvas'), c2 = h('canvas');
  body.append(h('div', { class: 'grid-2' },
    h('div', { class: 'card' }, h('h2', null, 'Completion over time'), h('p', { class: 'sub' }, 'Each logged day, with a 7-day rolling average'), h('div', { class: 'chart-box' }, c1)),
    h('div', { class: 'card' }, h('h2', null, 'By day of the week'), h('p', { class: 'sub' }, 'Average completion on logged days'), h('div', { class: 'chart-box' }, c2))
  ));
  const pctScore = A.score.map(s => Math.round(s * 100));
  chart(c1, {
    type: 'line',
    data: {
      labels: A.logged.map(d => fmt(d)), datasets: [
        { label: 'Daily', data: pctScore, borderColor: css('--line'), backgroundColor: css('--ink-3'), borderWidth: 1, pointRadius: 3 },
        { label: '7-day average', data: rolling(pctScore, 7).map(v => v === null ? null : Math.round(v)), borderColor: css('--accent'), backgroundColor: css('--accent'), borderWidth: 2, pointRadius: 0, tension: .3 }
      ]
    },
    options: { scales: { y: { min: 0, max: 100, ticks: { callback: v => v + '%' } }, x: { grid: { display: false } } } }
  });
  const order = [1, 2, 3, 4, 5, 6, 0];
  chart(c2, {
    type: 'bar',
    data: { labels: order.map(i => DOW[i]), datasets: [{ label: 'Completion', data: order.map(i => A.dowAvg[i] === null ? null : Math.round(A.dowAvg[i] * 100)), backgroundColor: css('--accent'), borderRadius: 4, maxBarThickness: 36 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 100, ticks: { callback: v => v + '%' } }, x: { grid: { display: false } } } }
  });

  // per item table
  const rows = [...A.items].sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
  const trendTag = t => t === null ? h('span', { class: 'muted' }, '—') : t >= 0.15 ? h('span', { class: 'tag good' }, `▲ ${(t * 100).toFixed(0)}`) : t <= -0.15 ? h('span', { class: 'tag bad' }, `▼ ${Math.abs(t * 100).toFixed(0)}`) : h('span', { class: 'tag' }, 'steady');
  body.append(h('div', { class: 'card', style: 'margin-bottom:16px' },
    h('h2', null, 'Every item'), h('p', { class: 'sub' }, 'Rate = days done ÷ logged days. Trend compares the second half of the period with the first.'),
    h('div', { class: 'table-wrap', style: 'margin-top:10px' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['Item', 'Done', 'Rate', 'Current streak', 'Longest', 'Trend', 'Best day', 'Last done'].map(t => h('th', null, t)))),
      h('tbody', null, rows.map(r => {
        const bd = r.byDow.map((v, i) => [v, i]).filter(([v]) => v !== null).sort((a, b) => b[0] - a[0])[0];
        return h('tr', null,
          h('td', { class: 'name' }, r.name),
          h('td', null, r.done),
          h('td', null, h('div', { class: 'bar-cell' }, h('div', { class: 'bar' }, h('span', { style: `width:${((r.rate || 0) * 100).toFixed(1)}%` })), pct(r.rate))),
          h('td', null, r.current ? h('span', { class: 'tag good' }, icon('flame'), ' ', r.current) : '—'),
          h('td', null, r.longest || '—'),
          h('td', null, trendTag(r.trend)),
          h('td', null, bd && bd[0] > 0 ? DOW[bd[1]] : '—'),
          h('td', null, r.lastDone ? fmt(r.lastDone) : 'never'));
      }))
    ))
  ));

  // heatmap
  const days = A.days.slice(-62);
  const heat = h('div', { class: 'heat', style: `grid-template-columns: minmax(140px, 220px) repeat(${days.length}, 14px)` });
  heat.append(h('div', { class: 'hn' }, ''));
  days.forEach(d => { const n = parseKey(d).getDate(); heat.append(h('div', { class: 'hd', title: fmtLong(d) }, n === 1 || n % 5 === 0 ? n : '')); });
  const ix = S.idx[k];
  for (const name of ix.items) {
    heat.append(h('div', { class: 'hn', title: name }, name));
    days.forEach(d => {
      const logged = ix.loggedDays.has(d);
      const on = ix.sets[name].has(d);
      heat.append(h('div', { class: 'hc' + (on ? ' on' : logged ? '' : ' off-log'), title: `${name} · ${fmtLong(d)}: ${on ? 'done' : logged ? 'not done' : 'day not logged'}` }));
    });
  }
  body.append(h('div', { class: 'card', style: 'margin-bottom:16px' },
    h('h2', null, 'Day-by-day map'), h('p', { class: 'sub' }, days.length < A.days.length ? 'Last 62 days of the selected period' : windowLabel(win)),
    h('div', { class: 'heat-wrap', style: 'margin-top:12px' }, heat),
    h('div', { class: 'legend' }, h('span', null, h('i', { style: 'background:var(--done)' }), 'Done'), h('span', null, h('i', { style: 'background:var(--miss)' }), 'Not done'), h('span', null, h('i', { style: 'border:1px dashed var(--line)' }), 'Day not logged'))
  ));

  // insights
  const ins = [];
  const keys = A.items.filter(i => i.lift !== null).sort((a, b) => b.lift - a.lift);
  if (keys[0] && keys[0].lift > 0.05) ins.push(['🔑', `When you do “${keys[0].name}”, the rest of your ${title.toLowerCase()} go ${(keys[0].lift * 100).toFixed(0)} pts better that day. It looks like a keystone item.`]);
  if (keys.length > 1 && keys[keys.length - 1].lift < -0.05) ins.push(['⚖️', `Days with “${keys[keys.length - 1].name}” have ${Math.abs(keys[keys.length - 1].lift * 100).toFixed(0)} pts lower completion of everything else — maybe it crowds the day.`]);
  const zero = A.items.filter(i => i.done === 0);
  if (zero.length) ins.push(['💤', `Never ticked in this period: ${zero.map(i => i.name).join(', ')}. Worth asking whether they still belong on the list, or need a smaller version.`]);
  const always = A.items.filter(i => i.rate === 1);
  if (always.length) ins.push(['✨', `Done on every logged day: ${always.map(i => i.name).join(', ')}.`]);
  const weekend = mean([A.dowAvg[0], A.dowAvg[6]].filter(v => v !== null)), weekday = mean([1, 2, 3, 4, 5].map(i => A.dowAvg[i]).filter(v => v !== null));
  if (weekend !== null && weekday !== null && Math.abs(weekend - weekday) >= 0.1) ins.push(['📅', `Weekends run ${Math.abs((weekend - weekday) * 100).toFixed(0)} pts ${weekend > weekday ? 'higher' : 'lower'} than weekdays (${pct(weekend)} vs ${pct(weekday)}).`]);
  const P = analyzePeriod();
  if (P.periods.length) {
    const pd = new Set(P.periods.flatMap(p => rangeDays(p.start, p.end)));
    const onP = A.logged.map((d, i) => pd.has(d) ? A.score[i] : null).filter(v => v !== null);
    const offP = A.logged.map((d, i) => !pd.has(d) ? A.score[i] : null).filter(v => v !== null);
    if (onP.length >= 2 && offP.length >= 3) ins.push(['🌸', `On period days your completion is ${pct(mean(onP))} vs ${pct(mean(offP))} on other days.`]);
  }
  if (ins.length) body.append(h('div', { class: 'card' }, h('h2', null, 'Patterns'), h('div', { style: 'margin-top:10px' }, insightList(ins))));
}

/* ---------- period ---------- */
function viewPeriod(win, body) {
  const P = analyzePeriod();
  if (!S.idx.period) { body.append(h('p', { class: 'empty' }, 'No period tracker sheet found.')); return; }
  if (!P.periods.length) { body.append(h('p', { class: 'empty' }, 'No period days logged yet.')); return; }
  const t = todayKey();
  const cd = cycleDayOn(P, t);
  body.append(h('div', { class: 'tiles' },
    tile('Next period', fmt(P.next), P.late ? `Late by ${plural(P.late, 'day')}` : `in ${plural(Math.max(0, diffDays(t, P.next)), 'day')} · window ${fmt(addDays(P.next, -P.spread))}–${fmt(addDays(P.next, P.spread))}`, P.late ? 'down' : ''),
    tile('Average cycle', P.avgCycle ? `${P.avgCycle.toFixed(1)} d` : '—', P.avgCycle ? `${plural(P.cycles.length, 'cycle')}${P.variation !== null ? ` · varies ${P.variation} d` : ''}` : 'Needs 2 periods — using 28 days for now'),
    tile('Average period', `${P.avgLen.toFixed(1)} d`, `${plural(P.periods.length, 'period')} logged`),
    cd ? tile('Today', `Day ${cd.day}`, cd.phase) : null,
    P.ovulation && P.ovulation >= t ? tile('Est. ovulation', fmt(P.ovulation), `Fertile window ${fmt(P.fertile[0])}–${fmt(P.fertile[1])}`) : null
  ));

  // calendar
  const months = [...new Set([...S.idx.period.dateSet].map(monthOf))].sort();
  const markSet = S.idx.period.marked;
  const spotSet = new Set(P.spotting.flatMap(r => r.days));
  const predSet = new Set();
  P.nextList.forEach(n => rangeDays(n, addDays(n, Math.max(1, Math.round(P.avgLen)) - 1)).forEach(d => { if (d >= t) predSet.add(d); }));
  const fertSet = new Set(P.fertile && P.fertile[1] >= t ? rangeDays(P.fertile[0], P.fertile[1]) : []);
  const cal = h('div', { class: 'cal-months' }, months.map(ym => {
    const [y, m] = ym.split('-').map(Number);
    const first = new Date(y, m - 1, 1).getDay();
    const n = new Date(y, m, 0).getDate();
    const grid = h('div', { class: 'cal-grid' }, ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(x => h('div', { class: 'dow' }, x)));
    for (let i = 0; i < first; i++) grid.append(h('div'));
    for (let d = 1; d <= n; d++) {
      const k = `${ym}-${pad(d)}`;
      let cls = 'd';
      if (markSet.has(k)) cls += spotSet.has(k) ? ' s' : ' p';
      else if (predSet.has(k)) cls += ' pred';
      else if (fertSet.has(k)) cls += ' fert';
      if (k === t) cls += ' today';
      grid.append(h('div', { class: cls, title: fmtLong(k) }, d));
    }
    return h('div', { class: 'cal' }, h('h3', null, monthLabel(ym)), grid);
  }));
  body.append(h('div', { class: 'card', style: 'margin-bottom:16px' }, h('h2', null, 'Calendar'),
    h('div', { style: 'margin-top:12px' }, cal),
    h('div', { class: 'legend' },
      h('span', null, h('i', { style: 'background:var(--pink)' }), 'Period'),
      h('span', null, h('i', { style: 'background:var(--pink-soft)' }), 'Spotting'),
      h('span', null, h('i', { style: 'border:2px dashed var(--pink)' }), 'Predicted'),
      h('span', null, h('i', { style: 'background:var(--accent-soft)' }), 'Est. fertile window'))));

  const g = h('div', { class: 'grid-2' });
  // periods table
  g.append(h('div', { class: 'card' }, h('h2', null, 'Logged periods'),
    h('div', { class: 'table-wrap', style: 'margin-top:10px' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['Start', 'End', 'Days', 'Cycle length'].map(x => h('th', null, x)))),
      h('tbody', null, P.periods.map((p, i) => h('tr', null, h('td', null, fmt(p.start)), h('td', null, fmt(p.end)), h('td', null, p.length),
        h('td', null, P.cycles[i] ? `${P.cycles[i].length} d` : (i === P.periods.length - 1 ? 'current' : '—')))))))));
  // cycle chart or note
  if (P.cycles.length >= 2) {
    const cv = h('canvas');
    g.append(h('div', { class: 'card' }, h('h2', null, 'Cycle length'), h('p', { class: 'sub' }, '21–35 days is the usual range'), h('div', { class: 'chart-box' }, cv)));
    setTimeout(() => chart(cv, { type: 'bar', data: { labels: P.cycles.map(c => fmt(c.from)), datasets: [{ label: 'Days', data: P.cycles.map(c => c.length), backgroundColor: css('--pink'), borderRadius: 4, maxBarThickness: 40 }] }, options: { plugins: { legend: { display: false } }, scales: { y: { suggestedMin: 15, suggestedMax: 40 }, x: { grid: { display: false } } } } }));
  }
  // cross-sheet effects
  const ins = [];
  const pd = new Set(P.periods.flatMap(p => rangeDays(p.start, p.end)));
  for (const k of ['dos', 'habits']) {
    const ix = S.idx[k];
    if (!ix) continue;
    const logged = [...ix.loggedDays];
    const on = logged.filter(d => pd.has(d)), off = logged.filter(d => !pd.has(d));
    if (on.length < 2 || off.length < 3) continue;
    const drops = ix.items.map(n => ({ n, a: on.filter(d => ix.sets[n].has(d)).length / on.length, b: off.filter(d => ix.sets[n].has(d)).length / off.length }))
      .map(x => ({ ...x, d: x.a - x.b })).filter(x => Math.abs(x.d) >= 0.2).sort((a, b) => a.d - b.d);
    drops.slice(0, 3).forEach(x => ins.push([x.d < 0 ? '🔻' : '🔺', `${x.n}: ${pct(x.a)} on period days vs ${pct(x.b)} otherwise.`]));
  }
  const W = S.idx.weight;
  if (W) {
    const byPhase = {};
    for (const [d, w] of Object.entries(W.entries)) { const c = cycleDayOn(P, d); if (c) (byPhase[c.phase] ||= []).push(w); }
    const ph = Object.entries(byPhase).filter(([, a]) => a.length >= 2);
    if (ph.length >= 2) ins.push(['⚖️', 'Average weight by phase: ' + ph.map(([p, a]) => `${p} ${mean(a).toFixed(1)} kg`).join(' · ') + '.']);
  }
  P.flags.forEach(f => ins.push(['⚠️', f]));
  if (P.estimated) ins.push(['ℹ️', 'Predictions use a 28-day cycle until two periods are logged.']);
  ins.push(['ℹ️', 'Ovulation and fertile-window dates are calendar estimates (14 days before the next period), not medical advice.']);
  g.append(h('div', { class: 'card' }, h('h2', null, 'How your cycle shows up elsewhere'), h('div', { style: 'margin-top:10px' }, insightList(ins))));
  body.append(g);
}

/* ---------- weight ---------- */
function viewWeight(win, body) {
  const W = analyzeWeight(win);
  if (!W) { body.append(h('p', { class: 'empty' }, 'No weight sheet found.')); return; }
  if (!W.n) { body.append(h('p', { class: 'empty' }, `No weigh-ins logged for ${windowLabel(win)}. Add one from “Log a day”.`)); return; }
  const R = W.rhythm;
  const change = W.latest[1] - W.first[1];
  const cm = S.data.profile?.height, bmi = cm ? bmiInfo(W.latest[1], cm) : null;
  const g = v => `${v >= 0 ? '+' : ''}${(v * 1000).toFixed(0)} g`;
  const lastNight = W.nightPts[W.nightPts.length - 1];
  if (bmi && bmi.cls !== 'good') body.append(h('div', { class: 'bmi ' + bmi.cls, style: 'margin:0 0 16px' }, icon(bmi.ico), h('div', null, h('b', null, `BMI ${bmi.bmi.toFixed(1)} · ${bmi.label}`), h('p', { class: 'sub' }, `${bmi.advice} Healthy range for ${cm} cm: ${bmi.lo}–${bmi.hi} kg.`))));
  body.append(h('div', { class: 'tiles' },
    tile('Latest morning', `${W.latest[1]} kg`, `before breakfast · ${fmt(W.latest[0])}`),
    lastNight ? tile('Latest night', `${lastNight[1]} kg`, `after dinner · ${fmt(lastNight[0])}`) : null,
    tile('Change', `${change >= 0 ? '+' : ''}${change.toFixed(1)} kg`, `morning to morning since ${fmt(W.first[0])}`, change < 0 ? 'up' : change > 0 ? 'down' : ''),
    tile('Weekly trend', W.slope !== null ? `${W.slope * 7 >= 0 ? '+' : ''}${(W.slope * 7).toFixed(2)} kg` : '—', W.slope !== null ? 'per week, from mornings' : 'Needs 3+ morning weigh-ins'),
    tile('Day gain', R.gainAvg !== null ? g(R.gainAvg) : '—', R.pairs ? `morning → night, avg of ${plural(R.pairs, 'day')}` : 'Needs a morning and a night weigh-in on one day'),
    tile('Overnight', R.dropAvg !== null ? g(R.dropAvg) : '—', R.nights ? `night → next morning, avg of ${plural(R.nights, 'night')}` : 'Needs a night and the next morning'),
    tile('Net per day', R.netAvg !== null ? g(R.netAvg) : '—', R.cycles.length ? `morning → next morning, ${plural(R.cycles.length, 'full day')}` : 'Needs a full morning → night → morning', R.netAvg === null ? '' : R.netAvg <= 0 ? 'up' : 'down'),
    tile('Range', `${W.minP[1]}–${W.maxP[1]} kg`, `low ${fmt(W.minP[0])} · high ${fmt(W.maxP[0])}`),
    bmi ? tile('BMI', bmi.bmi.toFixed(1), `${bmi.label} · healthy ${bmi.lo}–${bmi.hi} kg`, bmi.cls === 'good' ? 'up' : 'down') : null,
    W.slope !== null && W.n >= 5 ? tile('In 30 days, at this pace', `${(W.latest[1] + W.slope * 30).toFixed(1)} kg`, 'Rough projection') : null
  ));

  // what the data says
  const ins = [];
  if (R.gainAvg !== null) {
    ins.push(['⚖️', `Over the day (breakfast to after dinner) you ${R.gainAvg >= 0 ? 'gain' : 'lose'} about ${(Math.abs(R.gainAvg) * 1000).toFixed(0)} g${R.pairs >= 2 ? `, ranging from ${g(R.minGain.gain)} on ${fmt(R.minGain.d)} to ${g(R.maxGain.gain)} on ${fmt(R.maxGain.d)}` : ''}. That is mostly food, drink and water, not fat.`]);
  }
  if (R.dropAvg !== null) {
    ins.push(R.dropAvg < 0
      ? ['📉', `Overnight you lose about ${(-R.dropAvg * 1000).toFixed(0)} g (breathing, sweat, digestion).`]
      : ['🔺', `You weigh about ${(R.dropAvg * 1000).toFixed(0)} g more in the morning than the night before. Late or salty dinners can do this.`]);
  }
  if (R.recovery !== null) {
    const pc = Math.round(R.recovery * 100);
    ins.push(pc >= 90 ? ['✅', `Sleep takes back ${pc}% of the day’s gain, so your morning weight is a steady baseline.`]
      : pc >= 0 ? ['🔺', `Sleep takes back only ${pc}% of the day’s gain. The rest carries into the next morning (${g(R.netAvg)} a day on average).`]
      : ['🔺', 'Your morning weight is usually higher than the night before, so the gain keeps building day to day.']);
  } else if (R.netAvg !== null) {
    ins.push(R.netAvg > 0.05 ? ['🔺', `Each full day leaves you ${g(R.netAvg)} heavier by the next morning.`] : R.netAvg < -0.05 ? ['📉', `Each full day leaves you ${g(R.netAvg)} lighter by the next morning.`] : ['✅', 'A full day nets out to about zero by the next morning.']);
  }
  if (R.nightSlope !== null && W.slope !== null) {
    const nw = R.nightSlope * 7, mw = W.slope * 7, sgn = v => (v >= 0 ? '+' : '') + v.toFixed(2);
    ins.push(Math.abs(nw - mw) < 0.1 ? ['✨', `Mornings (${sgn(mw)} kg/week) and nights (${sgn(nw)} kg/week) are moving together, so the trend is real, not water noise.`]
      : ['ℹ️', `Mornings are trending ${sgn(mw)} kg/week but nights ${sgn(nw)} kg/week. They disagree, so wait for more days before trusting either.`]);
  }
  const dw = R.byDow.map((x, i) => [x, i]).filter(([x]) => x.n >= 2 && x.gain !== null);
  if (dw.length >= 3) {
    const hi = dw.reduce((a, b) => (b[0].gain > a[0].gain ? b : a)), lo = dw.reduce((a, b) => (b[0].gain < a[0].gain ? b : a));
    if (hi[0].gain - lo[0].gain >= 0.3) ins.push(['📅', `${DOW[hi[1]]} is your heaviest day (${g(hi[0].gain)} avg) and ${DOW[lo[1]]} the lightest (${g(lo[0].gain)}).`]);
  }
  if (R.morningOnly && R.nightN) ins.push(['📝', `${plural(R.morningOnly, 'morning')} in this period ${R.morningOnly === 1 ? 'has' : 'have'} no night weigh-in. Log both to make the day-gain numbers more reliable.`]);
  if (!R.nightN) ins.push(['📝', 'No night weigh-ins yet. Add one after dinner to see day gain, overnight loss and how much of it you keep.']);
  if (R.pairs && R.pairs < 5) ins.push(['ℹ️', `Based on ${plural(R.pairs, 'day')} of paired weigh-ins so far. Patterns firm up after 1–2 weeks.`]);
  if (ins.length) body.append(h('div', { class: 'card', style: 'margin-bottom:16px' }, h('h2', null, 'What your weigh-ins say'), h('p', { class: 'sub' }, 'Morning is before breakfast, night is after dinner.'), h('div', { style: 'margin-top:10px' }, insightList(ins))));

  const cv = h('canvas');
  body.append(h('div', { class: 'card', style: 'margin-bottom:16px' }, h('h2', null, 'Weight over time'), h('p', { class: 'sub' }, 'Morning and night weigh-ins, with a 7-day average of mornings to smooth daily water swings'), h('div', { class: 'chart-box tall' }, cv)));
  // one x-axis of every date that has either weigh-in
  const morn = Object.fromEntries(W.pts), nightMap = Object.fromEntries(W.nightPts);
  const dates = [...new Set([...W.pts.map(p => p[0]), ...W.nightPts.map(p => p[0])])].sort();
  const ma = Object.fromEntries(W.pts.map((p, i) => [p[0], +W.ma7[i].toFixed(2)]));
  const allKg = [...W.pts.map(p => p[1]), ...W.nightPts.map(p => p[1])];
  const lo = Math.floor(Math.min(...allKg) - 1), hi = Math.ceil(Math.max(...allKg) + 1);
  chart(cv, {
    type: 'line',
    data: {
      labels: dates.map(d => fmt(d)), datasets: [
        { label: 'Morning', data: dates.map(d => morn[d] ?? null), borderColor: css('--line'), backgroundColor: css('--ink-3'), borderWidth: 1, pointRadius: 3, spanGaps: true },
        ...(W.nightPts.length ? [{ label: 'Night', data: dates.map(d => nightMap[d] ?? null), borderColor: css('--line'), backgroundColor: css('--water'), borderWidth: 1, borderDash: [4, 4], pointRadius: 3, spanGaps: true }] : []),
        { label: '7-day average', data: dates.map(d => ma[d] ?? null), borderColor: css('--accent'), backgroundColor: css('--accent'), borderWidth: 2, pointRadius: 0, tension: .3, spanGaps: true }
      ]
    },
    options: { scales: { y: { min: lo, max: hi, ticks: { callback: v => v + ' kg' } }, x: { grid: { display: false } } } }
  });

  if (R.pairs || R.nights) {
    const c1 = h('canvas'), c2 = h('canvas');
    body.append(h('div', { class: 'grid-2', style: 'margin-bottom:16px' },
      h('div', { class: 'card' }, h('h2', null, 'Day gain and overnight change'), h('p', { class: 'sub' }, 'Up: what the day added. Down: what sleep took off'), h('div', { class: 'chart-box' }, c1)),
      h('div', { class: 'card' }, h('h2', null, 'By day of the week'), h('p', { class: 'sub' }, 'Average day gain, on days with both weigh-ins'), h('div', { class: 'chart-box' }, c2))
    ));
    const gainBy = Object.fromEntries(W.pts.filter(([d]) => nightMap[d] !== undefined).map(([d, m]) => [d, nightMap[d] - m]));
    const dropBy = Object.fromEntries(W.nightPts.filter(([d]) => morn[addDays(d, 1)] !== undefined || S.idx.weight.entries[addDays(d, 1)] !== undefined).map(([d, n]) => [d, S.idx.weight.entries[addDays(d, 1)] - n]));
    const ds = [...new Set([...Object.keys(gainBy), ...Object.keys(dropBy)])].sort();
    chart(c1, {
      type: 'bar',
      data: { labels: ds.map(d => fmt(d)), datasets: [
        { label: 'Day gain', data: ds.map(d => gainBy[d] === undefined ? null : Math.round(gainBy[d] * 1000)), backgroundColor: css('--orange'), borderRadius: 4, maxBarThickness: 28 },
        { label: 'Overnight', data: ds.map(d => dropBy[d] === undefined ? null : Math.round(dropBy[d] * 1000)), backgroundColor: css('--water'), borderRadius: 4, maxBarThickness: 28 }
      ] },
      options: { scales: { y: { ticks: { callback: v => v + ' g' } }, x: { grid: { display: false } } } }
    });
    const order = [1, 2, 3, 4, 5, 6, 0];
    chart(c2, {
      type: 'bar',
      data: { labels: order.map(i => DOW[i]), datasets: [{ label: 'Day gain', data: order.map(i => R.byDow[i].gain === null ? null : Math.round(R.byDow[i].gain * 1000)), backgroundColor: css('--accent'), borderRadius: 4, maxBarThickness: 36 }] },
      options: { plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: v => v + ' g' } }, x: { grid: { display: false } } } }
    });
  }

  const card = h('div', { class: 'card' }, h('h2', null, 'What moves your weight'), h('p', { class: 'sub' }, 'Average on days you did each item vs days you didn’t: how much the day adds, how much sleep takes off, and the change by next morning.'));
  if (W.effects.length) {
    const cell = m => (m ? h('span', { class: 'tag ' + (m.diff < -0.05 ? 'good' : m.diff > 0.05 ? 'bad' : '') }, `${m.diff >= 0 ? '+' : ''}${(m.diff * 1000).toFixed(0)} g`) : '—');
    card.append(h('div', { class: 'table-wrap', style: 'margin-top:10px' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['Item', 'Day gain', 'Overnight', 'Next morning'].map(x => h('th', null, x)))),
      h('tbody', null, W.effects.slice(0, 10).map(e => h('tr', null, h('td', { class: 'name' }, e.name), h('td', null, cell(e.day)), h('td', null, cell(e.over)), h('td', null, cell(e.next))))))));
    card.append(h('p', { class: 'hint' }, `Each cell is the difference on days you did the item. Green is lighter, red is heavier. Based on ${plural(R.pairs, 'paired day')} and ${plural(W.deltas.length, 'consecutive-morning pair')}. These are associations, not proof; more data makes them more trustworthy.`));
  } else {
    card.append(h('p', { class: 'muted', style: 'margin-top:10px' }, `Not enough data yet (${plural(R.pairs, 'paired day')}, ${plural(W.deltas.length, 'consecutive-morning pair')}). Each item needs 3 days done and 3 days not done. Weigh in morning and night for 1–2 weeks to unlock this.`));
  }
  body.append(card);
}

/* ---------- sleep ---------- */
/** A "night" = last evening's bedtime + this morning's wake-up, so it is dated by the wake-up day. */
function analyzeSleep([start, end]) {
  const days = S.data.sleep?.days || {};
  const mins = t => { const [a, b] = t.split(':').map(Number); return a * 60 + b; };
  const nights = [];
  for (const d of rangeDays(start, end)) {
    const wake = days[d]?.wake, bed = days[addDays(d, -1)]?.sleep;
    if (!wake || !bed) continue;
    const dur = (mins(wake) - mins(bed) + 1440) % 1440;
    if (dur < 60 || dur > 16 * 60) continue;   // almost certainly a mis-tap (a 20 min or 18 h "night")
    // bedtime on a continuous scale where 00:30 comes after 23:30 (anything before noon counts as past midnight)
    const bm = mins(bed), wm = mins(wake);
    nights.push({ date: d, bed, wake, dur, bedN: bm < 720 ? bm + 1440 : bm, wakeM: wm, dow: parseKey(d).getDay() });
  }
  const n = nights.length;
  const out = { nights, n, avg: null, inRange: null };
  if (!n) return out;
  const durs = nights.map(x => x.dur);
  out.avg = mean(durs);
  out.inRange = n >= 3 ? nights.filter(x => x.dur >= 420 && x.dur <= 540).length / n : null;
  out.shortest = nights.reduce((a, b) => (b.dur < a.dur ? b : a));
  out.longest = nights.reduce((a, b) => (b.dur > a.dur ? b : a));
  out.avgBed = mean(nights.map(x => x.bedN));
  out.avgWake = mean(nights.map(x => x.wakeM));
  const sd = (arr, m) => Math.sqrt(mean(arr.map(v => (v - m) ** 2)));
  out.bedSd = n >= 3 ? sd(nights.map(x => x.bedN), out.avgBed) : null;
  out.debt = nights.reduce((a, x) => a + Math.max(0, 480 - x.dur), 0);   // minutes short of 8 h
  // current run of 7–9 h nights that ends on the latest logged night
  let streak = 0;
  for (let i = n - 1; i >= 0 && nights[i].dur >= 420 && nights[i].dur <= 540; i--) streak++;
  out.streak = streak;
  const wk = nights.filter(x => x.dow === 0 || x.dow === 6), wd = nights.filter(x => x.dow !== 0 && x.dow !== 6);
  out.weekend = wk.length >= 2 && wd.length >= 3 ? [mean(wd.map(x => x.dur)), mean(wk.map(x => x.dur))] : null;
  out.recent = n >= 6 ? [mean(durs.slice(-3)), mean(durs.slice(-6, -3))] : null;
  // how the day after short vs long sleep went
  const dos = S.idx.dos;
  if (dos) {
    const score = d => dos.items.filter(nm => dos.sets[nm].has(d)).length / dos.items.length;
    const lg = nights.filter(x => dos.loggedDays.has(x.date));
    const short = lg.filter(x => x.dur < 390), good = lg.filter(x => x.dur >= 420);
    if (short.length >= 2 && good.length >= 2) out.next = { short: mean(short.map(x => score(x.date))), good: mean(good.map(x => score(x.date))), ns: short.length, ng: good.length };
  }
  return out;
}

const clockText = m => { m = Math.round(((m % 1440) + 1440) % 1440); return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };

function viewSleep(win, body) {
  const A = analyzeSleep(win);
  const logged = Object.values(S.data.sleep?.days || {}).filter(d => d.wake || d.sleep).length;
  if (!A.n) {
    body.append(h('p', { class: 'empty' }, logged
      ? 'No complete nights yet. A night needs a Sleep time one evening and a Wake up time the next morning.'
      : `No sleep logged for ${windowLabel(win)}. Tap Sleep at night and Wake up in the morning on the Today screen.`));
    return;
  }
  const ok = A.avg >= 420 && A.avg <= 540;
  body.append(h('div', { class: 'tiles' },
    tile('Average sleep', durText(Math.round(A.avg)), ok ? 'Within the 7–9 h range' : A.avg < 420 ? `${durText(Math.round(420 - A.avg))} under 7 h` : 'Over 9 h', ok ? 'up' : 'down'),
    tile('Nights logged', A.n, `${durText(A.shortest.dur)} shortest · ${durText(A.longest.dur)} longest`),
    A.inRange !== null ? tile('In the 7–9 h range', pct(A.inRange), A.streak ? `${plural(A.streak, 'night')} in a row now` : 'Not currently on a run') : null,
    tile('Usual bedtime', clockText(A.avgBed), A.bedSd !== null ? `varies by about ${Math.round(A.bedSd)} min` : 'Needs 3+ nights'),
    tile('Usual wake-up', clockText(A.avgWake)),
    tile('Sleep debt', durText(Math.round(A.debt)), `short of 8 h a night, over ${plural(A.n, 'night')}`, A.debt > 0 ? 'down' : 'up')
  ));

  const c1 = h('canvas'), c2 = h('canvas');
  body.append(h('div', { class: 'grid-2' },
    h('div', { class: 'card' }, h('h2', null, 'Hours slept'), h('p', { class: 'sub' }, 'Green nights are in the 7–9 h range'), h('div', { class: 'chart-box' }, c1)),
    h('div', { class: 'card' }, h('h2', null, 'Bedtime and wake-up'), h('p', { class: 'sub' }, 'Steadier lines mean a steadier body clock'), h('div', { class: 'chart-box' }, c2))));
  const labels = A.nights.map(x => fmt(x.date));
  const good = css('--accent'), low = css('--warn');
  chart(c1, {
    type: 'bar',
    data: { labels, datasets: [
      { label: 'Hours', data: A.nights.map(x => +(x.dur / 60).toFixed(2)), backgroundColor: A.nights.map(x => (x.dur >= 420 && x.dur <= 540 ? good : low)), borderRadius: 6 },
      { type: 'line', label: '7 h', data: A.nights.map(() => 7), borderColor: css('--ink-3'), borderDash: [5, 4], borderWidth: 1, pointRadius: 0 },
      { type: 'line', label: '9 h', data: A.nights.map(() => 9), borderColor: css('--ink-3'), borderDash: [5, 4], borderWidth: 1, pointRadius: 0 }
    ] },
    options: { scales: { y: { min: 0, ticks: { callback: v => v + ' h' } }, x: { grid: { display: false } } }, plugins: { legend: { display: false } } }
  });
  chart(c2, {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Bedtime', data: A.nights.map(x => +(x.bedN / 60).toFixed(2)), borderColor: css('--water'), backgroundColor: css('--water'), borderWidth: 2, pointRadius: 3, tension: .25 },
      { label: 'Wake-up', data: A.nights.map(x => +((x.wakeM + 1440) / 60).toFixed(2)), borderColor: css('--orange'), backgroundColor: css('--orange'), borderWidth: 2, pointRadius: 3, tension: .25 }
    ] },
    options: { scales: { y: { reverse: true, ticks: { callback: v => clockText(v * 60) } }, x: { grid: { display: false } } },
      plugins: { tooltip: { callbacks: { label: c => `${c.dataset.label}: ${clockText(c.parsed.y * 60)}` } } } }
  });

  const ins = [];
  if (A.n < 3) ins.push(['ℹ️', 'Log a few more nights and patterns will show up here.']);
  if (A.avg < 420) ins.push(['⚠️', `You average ${durText(Math.round(A.avg))}, about ${durText(Math.round(480 - A.avg))} short of a full 8 hours. Even moving bedtime 20–30 min earlier helps.`]);
  else if (A.avg > 540) ins.push(['ℹ️', `You average ${durText(Math.round(A.avg))}. Regularly sleeping over 9 hours can mean poor-quality sleep or low energy.`]);
  else ins.push(['✅', `Your average of ${durText(Math.round(A.avg))} is in the healthy 7–9 hour range.`]);
  if (A.bedSd !== null) ins.push(A.bedSd > 60
    ? ['🔴', `Your bedtime swings by about ${Math.round(A.bedSd)} minutes. A fixed bedtime matters as much as total hours.`]
    : ['✅', `Your bedtime is steady (within about ${Math.round(A.bedSd)} min), which is good for your body clock.`]);
  if (A.recent) { const d = A.recent[0] - A.recent[1]; if (Math.abs(d) >= 20) ins.push(d > 0 ? ['📈', `Sleeping ${durText(Math.round(d))} more lately than the nights before.`] : ['📉', `Sleeping ${durText(Math.round(-d))} less lately than the nights before.`]); }
  if (A.weekend) { const [wd, we] = A.weekend, d = we - wd; if (Math.abs(d) >= 45) ins.push(['📅', `Weekend nights are ${durText(Math.round(Math.abs(d)))} ${d > 0 ? 'longer' : 'shorter'} than weekday nights (${durText(Math.round(we))} vs ${durText(Math.round(wd))}).`]); }
  if (A.next) { const d = (A.next.good - A.next.short) * 100; if (Math.abs(d) >= 5) ins.push([d > 0 ? '🔑' : 'ℹ️', `After 7+ hours you complete ${pct(A.next.good)} of Daily Dos vs ${pct(A.next.short)} after under 6.5 h (${A.next.ng} and ${A.next.ns} days).`]); }
  ins.push(['🏆', `Best night: ${durText(A.longest.dur)} on ${fmt(A.longest.date)}. Shortest: ${durText(A.shortest.dur)} on ${fmt(A.shortest.date)}.`]);
  ins.push(['ℹ️', 'Based on the Sleep and Wake up times you log. These are associations, not medical advice.']);
  body.append(h('div', { class: 'card' }, h('h2', null, 'What stands out'), h('div', { style: 'margin-top:10px' }, insightList(ins))));
}

/* ---------- spending ---------- */
function viewSpending(win, body) {
  const A = analyzeSpending();
  const t = todayKey();
  const activeMonths = A.months.filter(m => m.items.length || m.budget);
  body.append(h('div', { class: 'tiles' },
    tile('Planned this year', rupee(A.yearPlanned), `${plural(activeMonths.length, 'month')} with a list`),
    tile('Budgets set', A.yearBudget ? rupee(A.yearBudget) : '—', A.yearBudget ? `${pct(A.yearPlanned / A.yearBudget)} planned against it` : 'Set budgets in Buy list'),
    tile('Planned & bought', rupee(A.yearBought), A.yearPlanned ? `${pct(A.yearBought / A.yearPlanned)} of planned value` : ''),
    tile('Restock due', A.restock.filter(r => r.status === 'overdue' || r.status === 'soon').length, 'overdue or within 7 days')
  ));

  const cv = h('canvas');
  const g = h('div', { class: 'grid-2' });
  g.append(h('div', { class: 'card' }, h('h2', null, 'Budget, planned and bought by month'), h('div', { class: 'chart-box' }, cv)));
  const ins = [];
  A.months.forEach(m => {
    if (m.budget && m.planned > m.budget) ins.push(['🔴', `${m.m}: planned ${rupee(m.planned)} is ${rupee(m.planned - m.budget)} over the ${rupee(m.budget)} budget.`]);
    if (m.items.length && monthKey(m.m) < monthOf(t)) {
      const rate = m.boughtCount / m.items.length;
      ins.push([rate >= .8 ? '✅' : '🟡', `${m.m}: bought ${m.boughtCount} of ${m.items.length} planned (${pct(rate)}).`]);
    }
    if (m.unplanned.length) ins.push(['🛍️', `${m.m}: ${plural(m.unplanned.length, 'unplanned purchase')} — ${m.unplanned.slice(0, 5).join(', ')}${m.unplanned.length > 5 ? '…' : ''}.`]);
  });
  if (A.repeat.length) ins.push(['🔁', `On the list in several months: ${A.repeat.slice(0, 5).map(r => `${r.name} (${r.months.join(', ')})`).join('; ')}.`]);
  if (A.priciest.length) ins.push(['💸', `Biggest planned items: ${A.priciest.slice(0, 4).map(i => `${i.product} ${rupee(i.cost)} (${i.m.slice(0, 3)})`).join(', ')}.`]);
  g.append(h('div', { class: 'card' }, h('h2', null, 'Buy-list insights'), h('div', { style: 'margin-top:10px' }, ins.length ? insightList(ins) : h('p', { class: 'muted' }, 'Add items and costs in the Buy list tab to see insights.'))));
  body.append(g);
  const shown = A.months.filter(m => m.items.length || m.budget || monthKey(m.m) >= monthOf(S.idx.first) && monthKey(m.m) <= monthOf(S.idx.last));
  chart(cv, {
    type: 'bar',
    data: {
      labels: shown.map(m => m.m.slice(0, 3)), datasets: [
        { label: 'Planned', data: shown.map(m => m.planned), backgroundColor: css('--accent'), borderRadius: 4, maxBarThickness: 28 },
        { label: 'Bought (planned items)', data: shown.map(m => m.boughtVal), backgroundColor: css('--orange'), borderRadius: 4, maxBarThickness: 28 },
        { label: 'Budget', data: shown.map(m => m.budget), backgroundColor: css('--ink-3'), borderRadius: 4, maxBarThickness: 28 }
      ]
    },
    options: { scales: { y: { beginAtZero: true, ticks: { callback: v => '₹' + Number(v).toLocaleString('en-IN') } }, x: { grid: { display: false } } }, plugins: { tooltip: { callbacks: { label: c => `${c.dataset.label}: ${rupee(c.raw)}` } } } }
  });

  // restock table
  const order = { overdue: 0, soon: 1, ok: 2, once: 3, never: 4 };
  const label = { overdue: ['bad', 'Overdue'], soon: ['warn', 'Due soon'], ok: ['good', 'Stocked'], once: ['', 'Bought once'], never: ['', 'Not bought yet'] };
  const rows = [...A.restock].sort((a, b) => order[a.status] - order[b.status] || (a.next || '').localeCompare(b.next || '') || b.count - a.count);
  body.append(h('div', { class: 'card', style: 'margin-top:16px' },
    h('h2', null, 'Restock tracker'), h('p', { class: 'sub' }, 'From the dates you ticked in Products. “Usually lasts” is the average gap between purchases.'),
    h('div', { class: 'table-wrap', style: 'margin-top:10px' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['Product', 'Times bought', 'Usually lasts', 'Last bought', 'Next expected', 'Status'].map(x => h('th', null, x)))),
      h('tbody', null, rows.map(r => h('tr', null,
        h('td', { class: 'name' }, r.name), h('td', null, r.count),
        h('td', null, r.interval ? `${Math.round(r.interval)} days` : '—'),
        h('td', null, r.last ? fmt(r.last) : '—'),
        h('td', null, r.next ? fmt(r.next) : '—'),
        h('td', null, h('span', { class: 'tag ' + label[r.status][0] }, label[r.status][1])))))))));
}

/* =========================================================
 * Demo data (made up)
 * ======================================================= */
function makeDemoData() {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const year = new Date().getFullYear();
  const dates = rangeDays(`${year}-09-01`, `${year}-12-31`);
  const t = todayKey();
  const past = dates.filter(d => d < t);
  const dos = ['Bath', 'Breakfast', 'Brush Teeth morning', 'Dinner', 'Exercise - 45 mins', 'Fold bed sheet', 'Learn a new language', 'Lunch', 'Meditate - 10 mins', 'Night brush teeth', 'Night face wash', 'Read books/ Art - 1 hour', 'Study Technology - 1 hour', 'Work', 'Face exercise 5 mins'];
  const dosP = [.97, .9, .97, .95, .45, .8, .2, .93, .35, .6, .55, .4, .5, .7, .25];
  const habits = ['Eat curry leaves', 'Eat fenu greek seeds', 'Eat Nuts', 'Exercise 30-45 mins', 'Face Massage', 'No sugar', 'Sun - Vitamin D - 10 mins', 'Tea', 'Water (2 liters)', 'Eat sesame seeds', 'Massage hair', 'No cheese', 'No maida'];
  const habP = [.5, .45, .6, .4, .35, .5, .3, .85, .55, .3, .25, .7, .6];
  const products = ['Blue harpic', 'Body scrub', 'Bodywise body wash', 'Brush', 'Clinic plus', 'Coconut oil', 'Colgate Active salt', 'Dettol', 'Fruits', 'Hair growth serum', 'Pears soap', 'Sesame oil', 'Surf excel', 'Tea varieties', 'Turmeric'];
  const prodEvery = [30, 45, 40, 60, 35, 25, 28, 50, 6, 40, 20, 30, 30, 21, 45];
  const gridOf = (names, probs, skip = .1) => {
    const logged = past.filter(() => rnd() > skip);
    return { sheetName: '', dates, items: names.map((n, i) => ({ name: n, marked: logged.filter(d => rnd() < probs[i] + (dow(d) % 6 === 0 ? -.1 : .05)) })) };
  };
  const prod = { sheetName: '', dates, items: products.map((n, i) => {
    const m = []; let d = addDays(dates[0], Math.floor(rnd() * 12));
    while (d < t) { m.push(d); d = addDays(d, Math.round(prodEvery[i] * (0.8 + rnd() * 0.4))); }
    return { name: n, marked: m };
  }) };
  const period = [];
  for (const [s, len] of [[`${year}-09-04`, 5], [`${year}-10-02`, 4], [`${year}-10-30`, 5]]) rangeDays(s, addDays(s, len - 1)).forEach(d => { if (d < t) period.push(d); });
  if (`${year}-09-15` < t) period.push(`${year}-09-15`);
  const entries = {}, nightW = {};
  let w = 64.8;
  past.forEach(d => { w += (rnd() - .55) * .35; if (rnd() > .25) entries[d] = +w.toFixed(1); if (rnd() > .4) nightW[d] = +(w + .4 + rnd() * .5).toFixed(1); });
  const waterDays = {};
  const sleepDays = {};
  past.slice(-14).forEach(d => { const bed = 22 * 60 + Math.floor(rnd() * 150), wake = 5 * 60 + 30 + Math.floor(rnd() * 120); sleepDays[d] = { sleep: `${pad(Math.floor(bed / 60) % 24)}:${pad(bed % 60)}`, wake: `${pad(Math.floor(wake / 60))}:${pad(wake % 60)}` }; });
  past.slice(-14).forEach(d => { const log = []; let tt = 8 * 60; const n = 4 + Math.floor(rnd() * 6); for (let i = 0; i < n; i++) { log.push({ t: `${pad(Math.floor(tt / 60))}:${pad(tt % 60)}`, ml: rnd() > .3 ? 250 : 350 }); tt += 60 + Math.floor(rnd() * 70); } waterDays[d] = { goal: 2000, total: log.reduce((s, e) => s + e.ml, 0), log }; });
  const buy = { sheetName: 'Month List To buy', slots: 11, months: {} };
  MONTHS.forEach(m => { buy.months[m] = []; });
  buy.months.September = [{ product: 'Coconut oil', cost: 220 }, { product: 'Bodywise body wash', cost: 499 }, { product: 'Tea varieties', cost: 350 }, { product: 'Brush', cost: 90 }];
  buy.months.October = [{ product: 'Hair growth serum', cost: 650 }, { product: 'Surf excel', cost: 310 }, { product: 'Fruits', cost: 600 }, { product: 'Running shoes', cost: 2800 }, { product: 'Turmeric', cost: 80 }];
  buy.months.November = [{ product: 'Coconut oil', cost: 220 }, { product: 'Winter moisturiser', cost: 420 }, { product: 'Sesame oil', cost: 260 }];
  buy.months.December = [{ product: 'Body scrub', cost: 550 }, { product: 'Fruits', cost: 600 }];
  return {
    title: `${year} Tracker (demo)`, timezone: 'Asia/Kolkata',
    sheets: {
      products: prod, dos: gridOf(dos, dosP), habits: gridOf(habits, habP, .25),
      period: { sheetName: '', dates, marked: period.sort() },
      weight: { sheetName: '', dates, entries, night: nightW },
      buy
    },
    profile: { height: 162, waterGoal: 2000, tumbler: 250 },
    water: { days: waterDays },
    sleep: { days: sleepDays },
    budgets: { September: 1500, October: 4000, November: 1200 }
  };
}

/* =========================================================
 * Wiring
 * ======================================================= */
/* =========================================================
 * ACCOUNT — sign in, years, upload, admin
 * ======================================================= */
/** Gender of whoever is on screen (the admin can be looking at someone else). */
const viewedGender = () => (S.viewUid === S.user?.uid ? S.user : S.members.find(m => m.uid === S.viewUid))?.gender || '';
const hidesPeriod = () => viewedGender() === 'male';

const confirmDiscard =() => !(pendingCount() || S.buyDirty) || confirm('Discard unsaved changes?');

function setAuthMsg(msg, isErr = true) {
  const m = $('#authMsg');
  m.textContent = msg || '';
  m.classList.toggle('err', !!msg && isErr);
}

function showAuth(msg) {
  $('#appRoot').hidden = true; $('#authScreen').hidden = false;
  setAuthMsg(msg);
}

function clearSheet() {
  S.data = null; S.idx = null; S.readOnly = false;
  document.body.classList.remove('readonly');
  $$('[data-empty]').forEach(e => { e.hidden = false; });
  $$('[data-ready]').forEach(e => { e.hidden = true; });
  $$('.grp').forEach(e => { e.hidden = true; });
  $$('[data-sheet-title]').forEach(e => { e.textContent = 'No sheet loaded'; });
  $('#banner').hidden = true;
  destroyCharts();
}

/** Called by Account whenever the signed-in person changes. */
async function onAuthChange(profile, msg) {
  if (!profile) {
    Object.assign(S, { user: null, members: [], memberYears: {}, groupMode: false, group: null, years: [], year: null, viewUid: null, demo: false, files: null, nextYear: null, pending: freshPending(), buyDraft: null, buyDirty: false });
    clearSheet();
    setLoader(false);
    showAuth(msg);
    return;
  }
  S.user = profile; S.viewUid = profile.uid;
  $('#authScreen').hidden = true; $('#appRoot').hidden = false; setAuthMsg('');
  $$('[data-user-label]').forEach(e => { e.textContent = profile.userName + (profile.role === 'admin' ? ' · admin' : ''); });
  $$('[data-hello]').forEach(e => { e.textContent = profile.userName; });
  $('#accountInfo').textContent =`Signed in as ${profile.userName} (${profile.email})`;
  const admin = profile.role === 'admin';
  $('#navAdmin').hidden = !admin;
  $('#navUpload').hidden = admin;   // admins do not upload files for themselves
  S.members = []; S.memberYears = {};
  if (admin) {
    try { S.members = (await Account.listMembers()).filter(m => !m.deleted); await loadMemberYears(); } catch (err) { toast(err.message, true); }
    await enterGroup();
    switchTab('log');
    setLoader(false);
    return;
  }
  fillUserSelect();
  await refreshYears();
  if (S.year) { await loadSheet(); switchTab('log'); } else { clearSheet(); switchTab('upload'); }
  setLoader(false);
  await showAdminUploadNotice();   // after the loader is gone, so the two never overlap
}

/** Tells a member when an admin uploaded a year for them, then deletes the notice so it shows only once. */
async function showAdminUploadNotice() {
  const notices = await Account.listNotices(S.user.uid);
  if (!notices.length) return;
  const by = [...new Set(notices.map(n => n.by))].join(', ');
  const years = notices.map(n => n.year).join(', ');
  const close = () => { overlay.remove(); Account.clearNotices(notices.map(n => n.id)); };
  const overlay = h('div', { class: 'modal-overlay', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'card notice-modal' },
      h('div', { class: 'notice-ico' }, icon('file-check')),
      h('h2', null, 'New file added'),
      h('p', null, `${by} uploaded your tracker for `, h('b', null, years), '.'),
      h('div', { class: 'notice-actions' }, h('button', { class: 'btn primary', onclick: close }, 'Got it'))));
  document.body.append(overlay);
}

async function loadMemberYears() {
  const ys = await Promise.all(S.members.map(m => Account.listYears(m.uid)));
  S.memberYears = Object.fromEntries(S.members.map((m, i) => [m.uid, ys[i]]));
}

function fillUserSelect() {
  const sel = $('#userSelect'), show = S.user.role === 'admin' && S.members.length > 0;
  sel.hidden = !show; $('#userIcon').hidden = !show;
  // the admin does not keep a tracker, so only list members who have uploaded something
  const people = S.members.filter(m => m.uid !== S.user.uid || (S.memberYears[m.uid] || []).length || m.uid === S.viewUid);
  fill(sel, h('option', { value: 'all' }, 'Everyone'), ...people.map(m => h('option', { value: m.uid }, m.uid === S.user.uid ? `Me (${m.userName})` : m.userName)));
  sel.value = S.viewUid;
}

/** Loads the year list of whoever is on screen and fills the year picker. */
async function refreshYears(preferred) {
  try {
    S.years = S.viewUid === 'all'
      ? [...new Set(Object.values(S.memberYears).flat().map(r => r.year))].sort().map(year => ({ year }))
      : await Account.listYears(S.viewUid);
  } catch (err) { S.years = []; toast(err.message, true); }
  const ys = S.years.map(r => r.year);
  S.year = [preferred, S.year, new Date().getFullYear(), ys[ys.length - 1]].find(y => ys.includes(y)) || null;
  const sel = $('#yearSelect');
  fill(sel, ...(ys.length ? ys.map(y => h('option', { value: y }, y)) : [h('option', { value: '' }, 'No files yet')]));
  sel.value = S.year || '';
  sel.disabled = !ys.length;
}

async function viewPerson(uid) {
  if (uid === 'all') {
    await enterGroup();
    switchTab(['log', 'buy', 'analysis'].includes(S.tab) ? S.tab : 'log');
    return;
  }
  S.viewUid = uid; S.demo = false; S.groupMode = false; S.group = null;
  await refreshYears();
  if (!S.year) { clearSheet(); toast('Nothing has been uploaded for this person yet.'); return; }
  await loadSheet();
  switchTab(['log', 'buy', 'analysis'].includes(S.tab) ? S.tab : 'log');
}

const fileToBase64 = file => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(new Error('Could not read that file.'));
  r.readAsDataURL(file);
});

async function renderUpload() {
  renderNextYear();
  const box = $('#myYears');
  try {
    const rows = await Account.listYears(S.user.uid);
    fill(box, rows.length
      ? h('div', { class: 'rows' }, rows.map(r => h('div', { class: 'row' }, h('b', null, r.year),
        h('span', { class: 'muted' }, r.uploadedAt?.toDate ? 'uploaded ' + r.uploadedAt.toDate().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''))))
      : h('p', { class: 'sub' }, 'Nothing uploaded yet.'));
  } catch (err) { fill(box, h('p', { class: 'sub err' }, err.message)); }
}

/* ---------- files: read-only view of any uploaded year (members: their own, admin: everyone's) ---------- */
const FILE_SHEETS = [['dos', 'Daily Dos'], ['habits', 'Habits'], ['products', 'Products'], ['period', 'Period'], ['weight', 'Weight'], ['buy', 'Month list'], ['sleep', 'Sleep'], ['water', 'Water']];

async function renderFiles() {
  const list = $('#filesList');
  if (S.demo) { fill(list, h('p', { class: 'sub' }, 'Files are not available in demo mode.')); fill($('#filesViewer')); return; }
  const admin = S.user.role === 'admin';
  try {
    if (admin) { S.members = (await Account.listMembers()).filter(m => !m.deleted); await loadMemberYears(); }
    const people = admin ? S.members.filter(m => m.role !== 'admin') : [S.user];
    const rows = await Promise.all(people.map(async p => ({ p, years: admin ? S.memberYears[p.uid] || [] : await Account.listYears(p.uid) })));
    $('#filesSub').textContent = admin ? 'Open any member’s uploaded year to read it here. Nothing on this page can be edited.' : 'Open one of your uploaded years to read it here. Nothing on this page can be edited.';
    fill(list, rows.length ? h('div', { class: 'rows', style: 'margin-top:0' }, rows.map(({ p, years }) => h('div', { class: 'row' },
      h('div', { class: 'who' }, h('b', null, admin ? p.userName : 'Your files')),
      h('div', { class: 'years' }, years.length
        ? years.map(r => h('button', { class: 'chip', 'data-file': p.uid + '_' + r.year, 'aria-pressed': String(S.files?.uid === p.uid && S.files?.year === r.year), onclick: () => openFile(p, r.year) }, r.year))
        : h('span', { class: 'muted' }, 'No files yet'))))) : h('p', { class: 'sub' }, 'No members yet.'));
    if (!S.files) fill($('#filesViewer'));
  } catch (err) { fill(list, h('p', { class: 'sub err' }, err.message)); }
}

async function openFile(person, year) {
  const prev = S.files;
  S.files = { uid: person.uid, name: person.userName, gender: person.gender, year, data: null, sheet: prev?.sheet || 'dos', month: null };
  $$('#filesList .chip').forEach(c => c.setAttribute('aria-pressed', String(c.dataset.file === person.uid + '_' + year)));
  fill($('#filesViewer'), h('p', { class: 'sub' }, `Loading ${year}…`));
  try {
    const data = await api('read', { year, asUid: person.uid === S.user.uid ? undefined : person.uid });
    if (S.files?.uid !== person.uid || S.files.year !== year) return;   // another file was opened meanwhile
    S.files.data = data;
    renderFileViewer();
  } catch (err) { S.files = null; fill($('#filesViewer'), h('p', { class: 'sub err' }, err.message)); }
}

/** the sheets of the open file that have something to show, in tab order */
function fileKinds(F) {
  const d = F.data, sh = d.sheets;
  return FILE_SHEETS.filter(([k]) => {
    if (k === 'period') return sh.period && F.gender !== 'male';
    if (k === 'sleep') return Object.keys(d.sleep?.days || {}).length;
    if (k === 'water') return Object.keys(d.water?.days || {}).length;
    return sh[k];
  });
}

function fileMonths(F, kind) {
  const d = F.data, sh = d.sheets;
  const dates = kind === 'sleep' ? Object.keys(d.sleep.days) : kind === 'water' ? Object.keys(d.water.days) : sh[kind]?.dates || [];
  return [...new Set(dates.map(monthOf))].sort();
}

function renderFileViewer() {
  const F = S.files, box = $('#filesViewer');
  if (!F?.data) return;
  const d = F.data, kinds = fileKinds(F);
  if (!kinds.length) { fill(box, h('div', { class: 'card' }, h('p', { class: 'sub' }, 'This file has no sheets the app can read.'))); return; }
  if (!kinds.some(([k]) => k === F.sheet)) F.sheet = kinds[0][0];
  const months = fileMonths(F, F.sheet);
  const perMonth = F.sheet !== 'buy';
  if (perMonth) {
    if (!months.includes(F.month)) { const now = monthOf(todayKey()); F.month = months.includes(now) ? now : months[months.length - 1]; }
  }
  const pr = d.profile || {};
  const bits = [pr.height ? `Height ${pr.height} cm` : null, pr.waterGoal ? `Water goal ${pr.waterGoal} ml` : null, pr.tumbler ? `Tumbler ${pr.tumbler} ml` : null].filter(Boolean);

  const body = h('div', { class: 'table-wrap' });
  const ym = F.month, inMonth = k => k.startsWith(ym);
  const none = text => h('p', { class: 'sub' }, text);
  const gridTable = (items, dates) => {
    const days = dates.filter(inMonth);
    return h('table', { class: 'table files-grid' },
      h('thead', null, h('tr', null, h('th', null, 'Item'), days.map(k => h('th', { title: fmt(k) }, Number(k.slice(8)))), h('th', null, 'Total'))),
      h('tbody', null, items.map(it => { const set = new Set(it.marked); return h('tr', null, h('td', { class: 'name' }, it.name), days.map(k => h('td', { class: set.has(k) ? 'on' : '' }, set.has(k) ? '✓' : '')), h('td', { class: 'tot' }, days.filter(k => set.has(k)).length)); })));
  };
  const simpleTable = (head, rows) => h('table', { class: 'table' }, h('thead', null, h('tr', null, head.map(x => h('th', null, x)))), h('tbody', null, rows.map(r => h('tr', null, r.map((c, i) => h('td', i === 0 ? { class: 'name' } : null, c))))));
  const dayLabel = k => fmt(k, { weekday: 'short', day: 'numeric', month: 'short' });
  const sh = d.sheets;
  if (['dos', 'habits', 'products'].includes(F.sheet)) {
    const s = sh[F.sheet];
    body.append(s.items.length ? gridTable(s.items, s.dates) : none('No items in this sheet.'));
  } else if (F.sheet === 'period') {
    body.append(gridTable([{ name: 'Period', marked: sh.period.marked }], sh.period.dates));
  } else if (F.sheet === 'weight') {
    const rows = sh.weight.dates.filter(inMonth).filter(k => sh.weight.entries[k] !== undefined || sh.weight.night?.[k] !== undefined)
      .map(k => [dayLabel(k), sh.weight.entries[k] !== undefined ? `${sh.weight.entries[k]} kg` : '—', sh.weight.night?.[k] !== undefined ? `${sh.weight.night[k]} kg` : '—']);
    body.append(rows.length ? simpleTable(['Date', 'Morning', 'Night'], rows) : none('No weigh-ins this month.'));
  } else if (F.sheet === 'buy') {
    const rows = MONTHS.filter(m => sh.buy.months[m]?.length || d.budgets?.[m] !== undefined)
      .map(m => [m, d.budgets?.[m] !== undefined ? rupee(d.budgets[m]) : '—', (sh.buy.months[m] || []).map(i => i.cost !== null ? `${i.product} (${rupee(i.cost)})` : i.product).join(', ') || '—']);
    body.append(rows.length ? simpleTable(['Month', 'Budget', 'Planned items'], rows) : none('Nothing planned in the buy list.'));
  } else if (F.sheet === 'sleep') {
    const rows = Object.keys(d.sleep.days).filter(inMonth).sort().map(k => [dayLabel(k), d.sleep.days[k].wake || '—', d.sleep.days[k].sleep || '—']);
    body.append(rows.length ? simpleTable(['Date', 'Wake up', 'Sleep'], rows) : none('No sleep logged this month.'));
  } else if (F.sheet === 'water') {
    const rows = Object.keys(d.water.days).filter(inMonth).sort().map(k => { const w = d.water.days[k]; return [dayLabel(k), `${w.total} ml`, w.goal ? `${w.goal} ml` : '—']; });
    body.append(rows.length ? simpleTable(['Date', 'Drunk', 'Goal'], rows) : none('No water logged this month.'));
  }

  const pick = (key, value) => () => { F[key] = value; renderFileViewer(); };
  fill(box, h('div', { class: 'card' },
    h('h2', null, `${F.name} · ${F.year}`),
    h('p', { class: 'sub' }, [d.title, bits.join(' · ')].filter(Boolean).join(' · ')),
    h('div', { class: 'pills', style: 'margin-top:12px' }, kinds.map(([k, label]) => h('button', { class: 'chip', 'aria-pressed': String(k === F.sheet), onclick: pick('sheet', k) }, label))),
    perMonth && months.length ? h('div', { class: 'month-chips' }, months.map(m => h('button', { class: 'chip', 'aria-pressed': String(m === F.month), onclick: pick('month', m) }, MONTHS[Number(m.slice(5)) - 1].slice(0, 3)))) : null,
    body));
}

/* ---------- next year's file: start from your tasks, add / remove, then upload ---------- */
const XLSX_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
let xlsxLoading = null;
const loadXlsx = () => window.XLSX ? Promise.resolve(window.XLSX) : (xlsxLoading ||= new Promise((resolve, reject) => {
  document.head.append(h('script', { src: XLSX_SRC, onload: () => resolve(window.XLSX), onerror: () => { xlsxLoading = null; reject(new Error('Could not load the Excel library. Check your connection.')); } }));
}));

/** The same layout the app reads: one date row + a task per row, a Period calendar, Weight, Month List and Body Settings. */
function buildYearWorkbook(X, { year, dos, habits, products, profile, slots, period }) {
  const days = [];
  for (let m = 0; m < 12; m++) for (let d = 1, n = new Date(year, m + 1, 0).getDate(); d <= n; d++) days.push([m, d]);
  // written as plain serial numbers with a date format, so no time zone can shift a day
  const D = (m, d, z = 'd-mmm') => ({ serial: Math.round((Date.UTC(year, m, d) - Date.UTC(1899, 11, 30)) / 864e5), z });
  const make = (rows, widths) => {
    const ws = {}, cols = Math.max(...rows.map(r => r.length));
    rows.forEach((row, r) => row.forEach((v, c) => {
      if (v === null || v === undefined || v === '') return;
      ws[X.utils.encode_cell({ r, c })] = typeof v === 'object' ? { t: 'n', v: v.serial, z: v.z } : typeof v === 'number' ? { t: 'n', v } : { t: 's', v: String(v) };
    }));
    ws['!ref'] = X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: cols - 1 } });
    if (widths) ws['!cols'] = widths.map(wch => ({ wch }));
    return ws;
  };
  const grid = (label, items) => make([[label, ...days.map(([m, d]) => D(m, d))], ...items.map(n => [n])], [28]);
  const wb = X.utils.book_new();
  const add = (name, ws) => X.utils.book_append_sheet(wb, ws, name);
  add('Products', grid('Products', products));
  add('Daily Dos', grid('Daily Dos', dos));
  add('Habits', grid('Habits', habits));
  if (period) {
    // a row of dates per month, with the row beneath it for the X marks
    add('Period', make(MONTHS.flatMap((name, m) => [[name, ...days.filter(x => x[0] === m).map(([mm, d]) => D(mm, d))], ['Period day: X']]), [16]));
  }
  add('Weight', make([['Date', 'Weight (kg)', 'Night Weight (kg)'], ...days.map(([m, d]) => [D(m, d, 'd-mmm-yy')])], [14, 14, 18]));
  add('Month List To buy', make([['Month', ...Array.from({ length: slots }, (_, i) => [`Product-${i + 1}`, `Product - ${i + 1} Cost Approx`]).flat()], ...MONTHS.map(m => [m])], [14]));
  if (profile && (profile.height || profile.waterGoal || profile.tumbler)) {
    add('Body Settings', make([['Setting', 'Value'], ['Height (cm)', profile.height], ['Water goal (ml)', profile.waterGoal], ['Tumbler (ml)', profile.tumbler]], [18, 10]));
  }
  return wb;
}

async function renderNextYear() {
  const box = $('#nextYearBox');
  if (!box || S.user?.role === 'admin') return;
  const N = S.nextYear;
  if (!N) {
    fill(box, h('h2', null, 'Create next year’s file'),
      h('p', { class: 'sub' }, 'Start from the tasks in your latest year, add or remove any, and the app builds the Excel file and uploads it for you. Daily ticks, weights and sleep start empty.'),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn primary', id: 'startNextYear', onclick: startNextYear }, icon('file-plus'), ' Start')),
      h('p', { class: 'sub', id: 'nextYearStatus' }));
    return;
  }
  const list = (key, title, hint) => {
    const input = h('input', { placeholder: hint, maxlength: '80', 'aria-label': `Add to ${title}` });
    const add = () => {
      const name = input.value.replace(/\s+/g, ' ').trim();
      if (!name) return;
      if (N[key].some(x => norm(x) === norm(name))) { toast(`“${name}” is already in ${title}.`, true); return; }
      N[key].push(name); renderNextYear();
      $$('#nextYearBox input').find(i => i.getAttribute('aria-label') === `Add to ${title}`)?.focus();
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    return h('div', { class: 'task-list' }, h('h3', null, `${title} (${N[key].length})`),
      h('div', { class: 'pillset' }, N[key].length ? N[key].map((name, i) => h('span', { class: 'year-tag' }, name,
        h('button', { class: 'x', type: 'button', title: `Remove ${name}`, 'aria-label': `Remove ${name}`, onclick: () => { N[key].splice(i, 1); renderNextYear(); } }, icon('x')))) : h('span', { class: 'muted' }, 'Nothing here')),
      h('div', { class: 'task-add' }, input, h('button', { class: 'btn small ghost', type: 'button', onclick: add }, icon('plus'), ' Add')));
  };
  const yearInput = h('input', { type: 'number', min: '2000', max: '2100', step: '1', value: N.year, id: 'nextYearNum', style: 'max-width:120px', oninput: e => { N.year = Number(e.target.value); } });
  fill(box, h('h2', null, `Create the ${N.year} file`),
    h('p', { class: 'sub' }, N.from ? `Started from your ${N.from} tasks. Remove what you no longer do and add anything new.` : 'You have no uploaded year yet, so add your own tasks.'),
    h('label', null, 'Year ', yearInput),
    list('dos', 'Daily Dos', 'e.g. Read 20 pages'), list('habits', 'Habits', 'e.g. No sugar'), list('products', 'Products', 'e.g. Shampoo'),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn primary', id: 'nextYearGo', onclick: () => createNextYear(true) }, icon('upload'), ' Create and upload'),
      h('button', { class: 'btn ghost', onclick: () => createNextYear(false) }, icon('download'), ' Download only'),
      h('button', { class: 'btn ghost', onclick: () => { S.nextYear = null; renderNextYear(); } }, 'Cancel')),
    h('p', { class: 'sub', id: 'nextYearStatus' }));
}

async function startNextYear() {
  const btn = $('#startNextYear'), st = $('#nextYearStatus');
  btn.disabled = true; st.className = 'sub'; st.textContent = 'Reading your latest year…';
  try {
    const years = (await Account.listYears(S.user.uid)).map(r => r.year);
    const latest = years.length ? Math.max(...years) : null;
    let d = null;
    if (latest) d = latest === S.year && S.viewUid === S.user.uid && S.data ? S.data : await api('read', { year: latest, asUid: undefined });
    const names = k => (d?.sheets?.[k]?.items || []).map(i => i.name);
    S.nextYear = {
      year: latest ? latest + 1 : new Date().getFullYear(), from: latest,
      dos: names('dos'), habits: names('habits'), products: names('products'),
      profile: d?.profile || null, slots: Math.max(d?.sheets?.buy?.slots || 0, 5), period: !hidesPeriod()
    };
    renderNextYear();
  } catch (err) { st.className = 'sub err'; st.textContent = err.message; btn.disabled = false; }
}

async function createNextYear(upload) {
  const N = S.nextYear, st = $('#nextYearStatus'), go = $('#nextYearGo');
  const problem = m => { st.className = 'sub err'; st.textContent = m; };
  st.className = 'sub';
  if (!Number.isInteger(N.year) || N.year < 2000 || N.year > 2100) return problem('Enter a year between 2000 and 2100.');
  if (!N.dos.length && !N.habits.length && !N.products.length) return problem('Add at least one task first.');
  if (upload && !confirmDiscard()) return;
  go.disabled = true; st.textContent = 'Building the file…';
  try {
    if (upload && (await Account.listYears(S.user.uid)).some(r => r.year === N.year)) return problem(`${N.year} has already been uploaded and cannot be replaced.`);
    const X = await loadXlsx();
    const wb = buildYearWorkbook(X, N);
    if (!upload) { X.writeFile(wb, `${N.year}.xlsx`); st.textContent = `${N.year}.xlsx downloaded.`; return; }
    st.textContent = 'Uploading and converting to Google Sheets — this can take up to a minute…';
    S.demo = false;
    await api('upload', { year: N.year, data: X.write(wb, { bookType: 'xlsx', type: 'base64' }) });
    const year = N.year;
    S.nextYear = null; renderNextYear();
    toast(`${year} created and uploaded`);
    S.viewUid = S.user.uid; fillUserSelect();
    await refreshYears(year);
    await loadSheet();
    switchTab('log');
  } catch (err) { problem(err.message); }
  finally { go.disabled = false; }
}

async function doUpload(e) {
  e.preventDefault();
  const st = $('#uploadStatus'), btn = $('#uploadBtn');
  const year = Number($('#uploadYear').value), file = $('#uploadFile').files[0];
  const problem = m => { st.textContent = m; st.className = 'sub err'; };
  st.className = 'sub';
  if (!file) return problem('Choose an Excel file.');
  if (!/\.xlsx$/i.test(file.name)) return problem('Please choose an .xlsx file.');
  if (file.size > 10 * 1024 * 1024) return problem('That file is larger than 10 MB.');
  if (!confirmDiscard()) return;
  btn.disabled = true; st.textContent = 'Checking…';
  try {
    if ((await Account.listYears(S.user.uid)).some(r => r.year === year)) return problem(`${year} has already been uploaded and cannot be replaced.`);
    st.textContent = 'Uploading and converting to Google Sheets — this can take up to a minute…';
    S.demo = false;
    await api('upload', { year, data: await fileToBase64(file) });
    e.target.reset(); st.textContent = '';
    toast(`${year} uploaded`);
    S.viewUid = S.user.uid; fillUserSelect();
    await refreshYears(year);
    await loadSheet();
    switchTab('log');
  } catch (err) { problem(err.message); }
  finally { btn.disabled = false; }
}

async function doAdminUpload(e) {
  e.preventDefault();
  const st = $('#adminUploadStatus'), btn = $('#adminUploadBtn');
  const uid = $('#adminUploadUser').value, year = Number($('#adminUploadYear').value), file = $('#adminUploadFile').files[0];
  const member = S.members.find(m => m.uid === uid);
  const problem = m => { st.textContent = m; st.className = 'sub err'; };
  st.className = 'sub';
  if (!member) return problem('Choose a person.');
  if (!file) return problem('Choose an Excel file.');
  if (!/\.xlsx$/i.test(file.name)) return problem('Please choose an .xlsx file.');
  if (file.size > 10 * 1024 * 1024) return problem('That file is larger than 10 MB.');
  btn.disabled = true; st.textContent = 'Checking…';
  try {
    // no client-side duplicate check: the server knows whether the Drive file still exists
    st.textContent = 'Uploading and converting to Google Sheets — this can take up to a minute…';
    const res = await api('upload', { year, asUid: uid, data: await fileToBase64(file) });
    e.target.reset(); st.textContent = '';
    toast(res?.noticeError ? `${year} uploaded, but ${member.userName} will not get a notice: ${res.noticeError}` : `${year} uploaded for ${member.userName}`, !!res?.noticeError);
    renderAdmin();
  } catch (err) { problem(err.message); }
  finally { btn.disabled = false; }
}

/** In-app confirm dialog (instead of the browser's). Resolves true on OK, false on Cancel / Esc / backdrop click. */
function askConfirm(title, message, okLabel = 'OK') {
  return new Promise(resolve => {
    const done = v => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') done(false); };
    const ok = h('button', { class: 'btn primary', onclick: () => done(true) }, okLabel);
    const overlay = h('div', { class: 'modal-overlay', role: 'dialog', 'aria-modal': 'true', onclick: e => { if (e.target === overlay) done(false); } },
      h('div', { class: 'card notice-modal' },
        h('div', { class: 'notice-ico warn' }, icon('trash')),
        h('h2', null, title),
        h('p', null, message),
        h('div', { class: 'notice-actions' }, h('button', { class: 'btn ghost', onclick: () => done(false) }, 'Cancel'), ok)));
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    ok.focus();
  });
}

async function removeYear(member, year) {
  if (!await askConfirm(`Remove ${year}?`, `${member.userName}'s ${year} file will be unlinked. You can then upload ${year} again, and the new file replaces the old one in Drive.`, 'Remove')) return;
  try {
    await Account.removeLink(member.uid, year);
    toast('Removed');
    if (S.viewUid === member.uid) { await refreshYears(); if (S.year) await loadSheet(); else clearSheet(); }
    renderAdmin();
  } catch (err) { toast(err.message, true); }
}

async function removeMember(member, years) {
  if (!await askConfirm(`Remove ${member.userName}?`, `This clears ${member.userName}'s row, year links, username and invite. Their Google Drive files are not touched. They need a new invite to join again.`, 'Remove')) return;
  try { await Account.removeMember(member, years); toast('Removed'); renderAdmin(); }
  catch (err) { toast(err.message, true); }
}

async function renderAdmin() {
  const memberBox = $('#memberList'), inviteBox = $('#inviteList');
  try {
    const [members, invites] = await Promise.all([Account.listMembers(), Account.listInvites()]);
    const years = await Promise.all(members.map(m => Account.listYears(m.uid)));
    S.members = members.filter(m => !m.deleted);   // deleted people are only listed below, never offered as a view
    S.memberYears = Object.fromEntries(members.map((m, i) => [m.uid, years[i]]));
    fillUserSelect();
    const upSel = $('#adminUploadUser'), prev = upSel.value;
    fill(upSel, ...S.members.filter(m => m.role !== 'admin').map(m => h('option', { value: m.uid }, m.userName)));
    if (prev) upSel.value = prev;
    const driveHref = l => (/^https:\/\/docs\.google\.com\//.test(l) ? l : null);
    fill(memberBox, ...members.map((m, i) => h('div', { class: 'row member' },
      h('div', { class: 'who' }, h('b', null, m.userName), m.role === 'admin' ? h('span', { class: 'pill' }, 'admin') : null, m.deleted ? h('span', { class: 'pill bad' }, 'Deleted') : null, h('div', { class: 'muted' }, m.email)),
      h('div', { class: 'years' }, m.role === 'admin' ? null : years[i].length
        ? years[i].map(r => h('span', { class: 'year-tag' }, r.year,
          driveHref(r.driveLink) ? h('a', { href: driveHref(r.driveLink), target: '_blank', rel: 'noopener', title: 'Open in Google Drive', 'aria-label': `Open ${r.year} in Google Drive` }, icon('external-link')) : null,
          h('button', { class: 'x', title: 'Remove this year so it can be uploaded again', 'aria-label': `Remove ${r.year}`, onclick: () => removeYear(m, r.year) }, icon('x'))))
        : h('span', { class: 'muted' }, 'No files yet')),
      m.deleted
        ? h('button', { class: 'btn small', onclick: () => removeMember(m, years[i]) }, icon('trash'), 'Remove')
        : h('button', { class: 'btn small', onclick: () => { $('#userSelect').value = m.uid; viewPerson(m.uid); } }, icon('eye'), 'View'))));
    fill(inviteBox, ...invites.map(inv => {
      const joined = members.some(m => m.email === inv.email);
      return h('div', { class: 'row' }, h('span', null, inv.email), h('span', { class: 'muted' }, joined ? 'registered' : 'waiting'),
        joined ? null : h('button', { class: 'btn small ghost', onclick: async () => { try { await Account.removeInvite(inv.email); renderAdmin(); } catch (err) { toast(err.message, true); } } }, 'Remove'));
    }));
  } catch (err) { fill(memberBox, h('p', { class: 'sub err' }, err.message)); }
}

function init() {
  setLoader(true);
  $$('.nav-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  applyTheme(store.get('theme', null) || 'auto');
  $$('[data-theme-toggle]').forEach(b => b.addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || 'auto';
    applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % 3]);
    if (S.data && S.tab === 'analysis') renderAnalysis();
  }));
  $$('.seg button').forEach(b => b.addEventListener('click', () => { S.mode = b.dataset.mode; renderLog(); }));
  $('#sheetForm').addEventListener('submit', e => { e.preventDefault(); S.demo = false; if (S.groupMode) loadGroup(); else loadSheet(); });
  $('#yearSelect').addEventListener('change', e => {
    if (!confirmDiscard()) { e.target.value = S.year || ''; return; }
    S.year = Number(e.target.value) || null; S.demo = false;
    if (S.groupMode) loadGroup(); else loadSheet();
  });
  $('#userSelect').addEventListener('change', e => {
    if (!confirmDiscard()) { e.target.value = S.viewUid; return; }
    viewPerson(e.target.value);
  });

  $('#discardBtn').addEventListener('click', () => { S.pending = freshPending(); renderLog(); });
  $('#saveDayBtn').addEventListener('click', saveAll);

  $('#addBuyRow').addEventListener('click', () => { S.buyDraft.items.push({ product: '', cost: '' }); markBuyDirty(); renderBuy(); const ins = $$('#buyRows input.p'); ins[ins.length - 1]?.focus(); });
  $('#saveBuyBtn').addEventListener('click', saveBuy);

  // ----- account screens -----
  $$('[data-auth]').forEach(b => b.addEventListener('click', () => {
    const reg = b.dataset.auth === 'register';
    $('#loginForm').hidden = reg; $('#registerForm').hidden = !reg;
    $$('[data-auth]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    setAuthMsg('');
  }));
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault(); setAuthMsg('Signing in…', false);
    try { await Account.signIn($('#loginEmail').value, $('#loginPassword').value); }
    catch (err) { setAuthMsg(err.message); }
  });
  $('#forgotBtn').addEventListener('click', async () => {
    const email = $('#loginEmail').value.trim();
    if (!email) return setAuthMsg('Type your email above first.');
    try { await Account.resetPassword(email); setAuthMsg('If that email is registered, a reset link is on its way.', false); }
    catch (err) { setAuthMsg(err.message); }
  });
  $('#registerForm').addEventListener('submit', async e => {
    e.preventDefault();
    if ($('#regPassword').value !== $('#regPassword2').value) return setAuthMsg('The two passwords do not match.');
    setAuthMsg('Creating your account…', false);
    try { await Account.register({ userName: $('#regUserName').value, gender: $('#regGender').value, email: $('#regEmail').value, password: $('#regPassword').value }); }
    catch (err) { setAuthMsg(err.message); }
  });
  $('#pwForm').addEventListener('submit', async e => {
    e.preventDefault();
    const st = $('#pwStatus');
    if ($('#pwNew').value !== $('#pwNew2').value) { st.textContent = 'The two new passwords do not match.'; return; }
    st.textContent = 'Changing…';
    try { await Account.changePassword($('#pwCur').value, $('#pwNew').value); e.target.reset(); st.textContent = '✓ Password changed'; toast('Password changed'); }
    catch (err) { st.textContent = '✗ ' + err.message; }
  });
  $('#delForm').addEventListener('submit', async e => {
    e.preventDefault();
    const st = $('#delStatus');
    if (S.user.role === 'admin') { st.textContent = '✗ The admin account cannot be deleted here.'; return; }
    if (!await askConfirm('Delete your account?', 'Your login will be removed and you will be signed out. This cannot be undone.', 'Delete')) return;
    st.textContent = 'Deleting…';
    try { await Account.deleteAccount($('#delPw').value); e.target.reset(); st.textContent = ''; }
    catch (err) { st.textContent = '✗ ' + err.message; }
  });
  $$('#signOutBtn, #topSignOut').forEach(b => b.addEventListener('click', () => { if (confirmDiscard()) Account.signOut(); }));
  $('#uploadForm').addEventListener('submit', doUpload);
  $('#adminUploadForm').addEventListener('submit', doAdminUpload);
  $('#inviteForm').addEventListener('submit', async e => {
    e.preventDefault();
    try { await Account.addInvite($('#inviteEmail').value); e.target.reset(); toast('Invited'); renderAdmin(); }
    catch (err) { toast(err.message, true); }
  });
  $('#demoBtn').addEventListener('click', () => { S.demo = true; S.data = null; loadSheet().then(() => switchTab('log')); });

  window.addEventListener('beforeunload', e => { if (pendingCount() || S.buyDirty) { e.preventDefault(); e.returnValue = ''; } });

  if (!Account.configured()) { setLoader(false); return showAuth('Setup needed: fill in config.js (see README).'); }
  Account.init(onAuthChange);   // shows the sign-in screen or the app once Firebase answers
}

document.addEventListener('DOMContentLoaded', init);
