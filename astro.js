/* Astrology for linked couples.
 * The admin links two members and enters each person's birth date, time and place. Both people then see
 * both South Indian rasi charts, and a banner on Today whenever the moving Moon is in the 1st, 7th or 8th
 * house from either person's rasi (Moon sign) or lagna (ascendant). 8th from rasi = Chandrashtamam.
 *
 * Everything is calculated in the browser: Astronomy Engine (loaded on demand from jsDelivr) gives the
 * tropical positions, the Lahiri ayanamsa turns them sidereal. Checked against the Swiss Ephemeris.
 * Firestore holds one astro_pairs row per couple; the rules let only the admin and those two people read it.
 */
'use strict';

/* =========================================================
 * Chart maths (no DOM in this part)
 * ======================================================= */
const AstroCore = (() => {
  const RASI = ['Mesham', 'Rishabam', 'Mithunam', 'Kadagam', 'Simmam', 'Kanni', 'Thulam', 'Viruchigam', 'Dhanusu', 'Magaram', 'Kumbam', 'Meenam'];
  const RASI_EN = ['Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo', 'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'];
  const NAK = ['Ashwini', 'Bharani', 'Krittika', 'Rohini', 'Mrigashirsha', 'Thiruvathirai', 'Punarpoosam', 'Poosam', 'Ayilyam',
    'Magam', 'Pooram', 'Uthiram', 'Hastham', 'Chithirai', 'Swathi', 'Visakam', 'Anusham', 'Kettai',
    'Moolam', 'Pooradam', 'Uthiradam', 'Thiruvonam', 'Avittam', 'Sadhayam', 'Poorattathi', 'Uthirattathi', 'Revathi'];
  // abbreviation, Astronomy Engine body, Tamil name
  const PLANETS = [['Su', 'Sun', 'Suriyan'], ['Mo', 'Moon', 'Chandran'], ['Ma', 'Mars', 'Sevvai'], ['Me', 'Mercury', 'Budhan'],
    ['Ju', 'Jupiter', 'Guru'], ['Ve', 'Venus', 'Sukran'], ['Sa', 'Saturn', 'Sani'], ['Ra', null, 'Rahu'], ['Ke', null, 'Ketu']];
  const WATCH = [1, 7, 8];   // houses from rasi / lagna that raise an alert

  const norm360 = x => ((x % 360) + 360) % 360;
  const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
  const jdOf = date => date.getTime() / 864e5 + 2440587.5;
  const signOf = lon => Math.floor(norm360(lon) / 30);
  const houseFrom = (ref, sign) => ((sign - ref + 12) % 12) + 1;
  const ordinal = n => n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');

  /** Lahiri (Chitrapaksha) ayanamsa: the Swiss Ephemeris value at J2000 carried forward by IAU 2006 general precession. */
  function ayanamsa(date) {
    const T = (jdOf(date) - 2451545) / 36525;
    return 23.857092353708822 + (5028.796195 * T + 1.1054348 * T * T) / 3600;
  }
  /** Mean lunar node (Rahu), tropical. */
  function meanNode(date) {
    const T = (jdOf(date) - 2451545) / 36525;
    return norm360(125.04452 - 1934.136261 * T + 0.0020708 * T * T + T * T * T / 450000);
  }

  function tropical(A, body, date) {
    const t = A.MakeTime(date);
    if (body === 'Moon') return A.EclipticGeoMoon(t).lon;
    return A.Ecliptic(A.GeoVector(body, t, true)).elon;
  }

  /** Sidereal Moon longitude at a moment. */
  function moonLon(A, date) { return norm360(tropical(A, 'Moon', date) - ayanamsa(date)); }

  /** Sidereal ascendant for a place (east longitude positive). */
  function ascendant(A, date, lat, lon) {
    const t = A.MakeTime(date);
    const ramc = rad(norm360(A.SiderealTime(t) * 15 + lon));
    const eps = rad(A.e_tilt(t).tobl);
    const asc = deg(Math.atan2(Math.cos(ramc), -(Math.sin(ramc) * Math.cos(eps) + Math.tan(rad(lat)) * Math.sin(eps))));
    return norm360(asc - ayanamsa(date));
  }

  /** Full rasi chart. date is the birth moment (a real Date, i.e. UTC inside). */
  function chart(A, date, lat, lon) {
    const ay = ayanamsa(date), before = new Date(date.getTime() - 36e5), after = new Date(date.getTime() + 36e5);
    const planets = {};
    for (const [ab, body] of PLANETS) {
      if (!body) continue;
      const l = norm360(tropical(A, body, date) - ay);
      // speed from one hour either side (tropical; the ayanamsa barely moves in two hours)
      const speed = ((tropical(A, body, after) - tropical(A, body, before) + 540) % 360) - 180;
      planets[ab] = { lon: l, sign: signOf(l), retro: ab !== 'Su' && ab !== 'Mo' && speed < 0 };
    }
    const ra = norm360(meanNode(date) - ay);
    planets.Ra = { lon: ra, sign: signOf(ra), retro: true };
    planets.Ke = { lon: norm360(ra + 180), sign: signOf(ra + 180), retro: true };
    const asc = ascendant(A, date, lat, lon), moon = planets.Mo.lon;
    const nakIdx = Math.floor(moon / (360 / 27));
    return {
      asc, lagna: signOf(asc), rasi: planets.Mo.sign, planets, nakIdx,
      nakshatra: NAK[nakIdx], pada: Math.floor((moon % (360 / 27)) / (360 / 108)) + 1
    };
  }

  /** Splits [from, to] into stretches where key(date) stays the same, finding each change to within a minute.
   *  The step must be shorter than the shortest stretch (2 hours suits Moon signs, nakshatras and tithis). */
  function segments(key, from, to, step = 2 * 3600e3) {
    const out = [];
    let a = from.getTime(), ka = key(from);
    for (let b = a + step; ; b += step) {
      const end = Math.min(b, to.getTime()), kb = key(new Date(end));
      if (kb !== ka) {
        let lo = end - step < a ? a : end - step, hi = end;
        while (hi - lo > 60e3) { const mid = (lo + hi) / 2; if (key(new Date(mid)) === ka) lo = mid; else hi = mid; }
        out.push({ key: ka, start: new Date(a), end: new Date(hi) });
        a = hi; ka = kb;
      }
      if (end >= to.getTime()) break;
    }
    out.push({ key: ka, start: new Date(a), end: new Date(to.getTime()) });
    return out;
  }
  /** Moon-sign stretches: [{ sign, start, end }] */
  const moonSegments = (A, from, to) => segments(d => signOf(moonLon(A, d)), from, to).map(s => ({ sign: s.key, start: s.start, end: s.end }));
  /** Nakshatra stretches: [{ nak, start, end }] */
  const nakSegments = (A, from, to) => segments(d => Math.floor(moonLon(A, d) / (360 / 27)), from, to).map(s => ({ nak: s.key, start: s.start, end: s.end }));
  /** Tithi stretches: [{ tithi (0-29), start, end }] */
  const tithiOf = (A, d) => Math.floor(norm360(tropical(A, 'Moon', d) - tropical(A, 'Sun', d)) / 12);
  const tithiSegments = (A, from, to) => segments(d => tithiOf(A, d), from, to).map(s => ({ tithi: s.key, start: s.start, end: s.end }));
  const TITHI = ['Prathamai', 'Dwitiyai', 'Tritiyai', 'Chaturthi', 'Panchami', 'Shashti', 'Saptami', 'Ashtami', 'Navami', 'Dasami', 'Ekadasi', 'Dwadasi', 'Trayodasi', 'Chaturdasi'];
  const tithiName = i => i === 14 ? 'Pournami' : i === 29 ? 'Amavasai' : `${i < 15 ? 'Shukla' : 'Krishna'} ${TITHI[i % 15]}`;

  /* ----- gocharam: transits counted from the birth rasi, with the classic good houses ----- */
  const GOOD = { Su: [3, 6, 10, 11], Ma: [3, 6, 11], Me: [2, 4, 6, 8, 10, 11], Ju: [2, 5, 7, 9, 11], Ve: [1, 2, 3, 4, 5, 8, 9, 11, 12], Sa: [3, 6, 11], Ra: [3, 6, 11], Ke: [3, 6, 11] };
  /** [{ ab, sign, house, good, retro }] for the slow-moving planets, plus Sani's special phases. */
  function gochara(natal, now) {
    const list = Object.keys(GOOD).map(ab => {
      const p = now[ab], house = houseFrom(natal.rasi, p.sign);
      return { ab, sign: p.sign, house, good: GOOD[ab].includes(house), retro: p.retro && ab !== 'Ra' && ab !== 'Ke' };
    });
    const sa = list.find(x => x.ab === 'Sa').house;
    const sani = sa === 12 ? 'Sade Sati (first phase)' : sa === 1 ? 'Sade Sati (peak, Janma Sani)' : sa === 2 ? 'Sade Sati (last phase)'
      : sa === 8 ? 'Ashtama Sani' : sa === 4 ? 'Ardhashtama Sani' : '';
    return { list, sani, guruBalam: list.find(x => x.ab === 'Ju').good };
  }

  /* ----- Tara balam: today's nakshatra counted from the birth nakshatra ----- */
  const TARA = [['Janma', 'mixed'], ['Sampat', 'good'], ['Vipat', 'bad'], ['Kshema', 'good'], ['Pratyak', 'bad'], ['Sadhana', 'good'], ['Naidhana', 'bad'], ['Mitra', 'good'], ['Parama Mitra', 'good']];
  const tara = (birthNak, nowNak) => { const n = ((nowNak - birthNak) % 27 + 27) % 27 % 9; return { n: n + 1, name: TARA[n][0], kind: TARA[n][1] }; };

  /* ----- Rahu kalam, Yamagandam, Kuligai: one eighth of daylight each, by weekday ----- */
  const KALAM = { rahu: [8, 2, 7, 5, 6, 4, 3], yama: [5, 4, 3, 2, 1, 7, 6], kuli: [7, 6, 5, 4, 3, 2, 1] };
  /** dayStart = local midnight. Returns { sunrise, sunset, rahu: [from, to], yama, kuli } or null near the poles. */
  function kalams(A, dayStart, lat, lon) {
    const obs = new A.Observer(lat, lon, 0);
    const rise = A.SearchRiseSet(A.Body.Sun, obs, +1, A.MakeTime(dayStart), 1);
    if (!rise) return null;
    const set = A.SearchRiseSet(A.Body.Sun, obs, -1, rise, 1);
    if (!set) return null;
    const r = rise.date.getTime(), part = (set.date.getTime() - r) / 8, wd = dayStart.getDay();
    const span = k => [new Date(r + (k - 1) * part), new Date(r + k * part)];
    return { sunrise: rise.date, sunset: set.date, rahu: span(KALAM.rahu[wd]), yama: span(KALAM.yama[wd]), kuli: span(KALAM.kuli[wd]) };
  }

  /** For each Moon stretch, which watched houses it falls in for this chart. Only stretches with a hit are returned. */
  function hits(ch, segments) {
    return segments.map(s => {
      const fromRasi = houseFrom(ch.rasi, s.sign), fromLagna = houseFrom(ch.lagna, s.sign);
      const why = [];
      if (WATCH.includes(fromRasi)) why.push({ ref: 'rasi', house: fromRasi });
      if (WATCH.includes(fromLagna)) why.push({ ref: 'lagna', house: fromLagna });
      return why.length ? { ...s, why } : null;
    }).filter(Boolean);
  }

  const label = w => w.ref === 'rasi' && w.house === 8 ? '8th from rasi (Chandrashtamam)'
    : w.ref === 'rasi' && w.house === 1 ? '1st from rasi (Janma)'
    : `${ordinal(w.house)} from ${w.ref}`;

  /** Minutes the clock in timeZone is ahead of UTC at that instant. */
  function tzOffsetMin(timeZone, date) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(date).map(x => [x.type, x.value]));
    return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - date.getTime()) / 60e3;
  }
  /** Local wall-clock date + time in an IANA time zone -> the real moment. */
  function birthMoment(dateStr, timeStr, timeZone) {
    const [y, m, d] = dateStr.split('-').map(Number), [hh, mm] = timeStr.split(':').map(Number);
    const wall = Date.UTC(y, m - 1, d, hh, mm);
    let t = wall - tzOffsetMin(timeZone, new Date(wall)) * 60e3;
    t = wall - tzOffsetMin(timeZone, new Date(t)) * 60e3;   // second pass settles DST edges
    return new Date(t);
  }

  return { RASI, RASI_EN, NAK, PLANETS, WATCH, GOOD, signOf, houseFrom, ordinal, ayanamsa, moonLon, ascendant, chart, segments, moonSegments, nakSegments, tithiSegments, tithiName, gochara, tara, kalams, hits, label, birthMoment, tzOffsetMin };
})();
if (typeof module !== 'undefined') module.exports = AstroCore;

/* =========================================================
 * Browser part
 * ======================================================= */
const Astro = (() => {
  if (typeof document === 'undefined') return null;
  const C = AstroCore;
  const LIB = 'https://cdn.jsdelivr.net/npm/astronomy-engine@2.1.19/astronomy.browser.min.js';
  const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
  // where each rasi sits in the fixed South Indian 4 x 4 grid: [row, col]
  const CELL = [[0, 1], [0, 2], [0, 3], [1, 3], [2, 3], [3, 3], [3, 2], [3, 1], [3, 0], [2, 0], [1, 0], [0, 0]];
  let lib = null, pair = null, pairs = [], loaded = false;

  function loadLib() {
    if (window.Astronomy) return Promise.resolve(window.Astronomy);
    lib ||= new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = LIB; s.async = true;
      s.onload = () => window.Astronomy ? res(window.Astronomy) : rej(new Error('The chart library did not load.'));
      s.onerror = () => { lib = null; rej(new Error('Could not load the chart library. Check your connection.')); };
      document.head.append(s);
    });
    return lib;
  }

  const timeFmt = d => d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  const dayFmt = d => d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const whenText = (s, dayStart, dayEnd) => {
    const from = s.start <= dayStart ? null : s.start, to = s.end >= dayEnd ? null : s.end;
    if (!from && !to) return 'all day';
    if (!from) return 'until ' + timeFmt(to);
    if (!to) return 'from ' + timeFmt(from);
    return `${timeFmt(from)} – ${timeFmt(to)}`;
  };

  function personChart(A, uid) {
    const b = pair.births[uid];
    return C.chart(A, C.birthMoment(b.date, b.time, b.tz), b.lat, b.lon);
  }

  /* ---------- South Indian chart ---------- */
  function grid(ch, name, b, nowSign) {
    const cells = C.RASI.map((r, i) => {
      const here = C.PLANETS.filter(([ab]) => ch.planets[ab].sign === i)
        .map(([ab]) => h('span', { class: 'astro-pl' + (ab === 'Mo' ? ' moon' : '') }, ab + (ch.planets[ab].retro && ab !== 'Ra' && ab !== 'Ke' ? '®' : '')));
      const [row, col] = CELL[i];
      return h('div', { class: 'astro-cell' + (i === ch.lagna ? ' lagna' : '') + (i === nowSign ? ' now' : ''), style: `grid-row:${row + 1};grid-column:${col + 1}`, title: `${r} (${C.RASI_EN[i]})` },
        h('span', { class: 'astro-sign' }, r),
        h('div', { class: 'astro-pls' }, i === ch.lagna ? h('span', { class: 'astro-pl la' }, 'La') : null, here),
        i === nowSign ? h('span', { class: 'astro-now', title: 'Where the Moon is now' }, icon('moon'), 'now') : null);
    });
    return h('div', { class: 'astro-grid', role: 'img', 'aria-label': `Rasi chart of ${name}: lagna ${C.RASI[ch.lagna]}, rasi ${C.RASI[ch.rasi]}` },
      cells,
      h('div', { class: 'astro-mid' }, h('b', null, name), h('span', null, 'Rasi chart'),
        h('span', { class: 'muted' }, `${fmt(b.date, { day: 'numeric', month: 'short', year: 'numeric' })} · ${b.time}`)));
  }

  function chartCard(A, uid, nowSign) {
    const b = pair.births[uid], name = pair.names[uid] || 'Person', ch = personChart(A, uid);
    return h('div', { class: 'card astro-card' },
      h('div', { class: 'card-head' }, h('h2', null, name), uid === S.user?.uid ? h('span', { class: 'pill teal' }, 'You') : null),
      grid(ch, name, b, nowSign),
      h('dl', { class: 'astro-facts' },
        h('dt', null, 'Lagna'), h('dd', null, `${C.RASI[ch.lagna]} (${C.RASI_EN[ch.lagna]})`),
        h('dt', null, 'Rasi'), h('dd', null, `${C.RASI[ch.rasi]} (${C.RASI_EN[ch.rasi]})`),
        h('dt', null, 'Nakshatra'), h('dd', null, `${ch.nakshatra}, pada ${ch.pada}`),
        h('dt', null, 'Born'), h('dd', null, `${fmt(b.date, { day: 'numeric', month: 'long', year: 'numeric' })}, ${b.time} · ${b.place}`)),
      h('p', { class: 'sub astro-legend' }, 'La = lagna · ® = retrograde · ', h('span', { class: 'astro-now-key' }, icon('moon'), 'now'), ' = Moon today'));
  }

  /* ---------- daily reading ---------- */
  // The Moon (1st/7th/8th from rasi or lagna) and Tara balam decide the day's rating; the slow planets
  // (gocharam from the birth rasi) are the background "season" and add advice but never change the rating.
  const PL = Object.fromEntries(C.PLANETS.map(([ab, , ta]) => [ab, ta]));
  const nameOf = uid => pair.names[uid] || 'Person';
  const who = uid => uid === S.user?.uid ? 'You' : nameOf(uid);
  const today = () => { const d0 = startOfDay(new Date()); return [d0, new Date(d0.getTime() + 864e5)]; };
  const dayNo = () => Math.round(startOfDay(new Date()).getTime() / 864e5);
  const pick = (arr, salt = 0) => arr[(dayNo() + salt) % arr.length];
  const overlap = (s, a, b) => Math.max(0, Math.min(s.end, b) - Math.max(s.start, a));
  const span = (s, a, b) => whenText(s, a, b);
  const RATING = { good: 'Good day', mixed: 'Mixed day', bad: 'Careful day' };
  const WORST = { good: 0, mixed: 1, bad: 2 };

  const BASE = {
    good: ['A good day overall: go ahead with plans and decisions.', 'Things should flow well today: use it to get important things done.', 'A positive day: a good time to start something or meet people.'],
    mixed: ['A mixed day: keep plans flexible and pace yourself.', 'Some ups and downs today: focus on routine work and avoid rushing.', 'An average day: fine for steady work, less so for big moves.'],
    bad: ['Keep the day simple: rest, avoid arguments and postpone big decisions.', 'Go gently today: stick to routine and don’t take things personally.', 'A day to slow down: avoid risks, new starts and heated topics.']
  };
  const MOON_TIP = {
    'rasi-8': 'Chandrashtamam: avoid starting anything new, long travel or signing important papers.',
    'lagna-8': 'Moon 8th from lagna: energy may dip; avoid risks and look after your health.',
    'rasi-1': 'Moon on the birth rasi: feelings run high; rest well and don’t overcommit.',
    'lagna-1': 'Moon on the lagna: you may feel restless; keep the schedule light.',
    'rasi-7': 'Moon 7th from rasi: choose your words carefully with your partner and others.',
    'lagna-7': 'Moon 7th from lagna: avoid arguments and give others some space.'
  };
  const MOON_ORDER = ['rasi-8', 'lagna-8', 'rasi-1', 'lagna-1', 'rasi-7', 'lagna-7'];
  const MOON_GOOD = ['Moon in a favourable house: emotions stay steady; good for conversations and plans.', 'The Moon is kind today: you should feel calm and clear-headed.'];
  const TARA_TIP = {
    'Janma': 'Janma tara: a sensitive day; look after your health and avoid risks.',
    'Sampat': 'Sampat tara: good for money matters and purchases.',
    'Vipat': 'Vipat tara: expect small hurdles; double-check plans and documents.',
    'Kshema': 'Kshema tara: good for health, home and wellbeing.',
    'Pratyak': 'Pratyak tara: obstacles are likely; avoid confrontations.',
    'Sadhana': 'Sadhana tara: effort pays off; good for pushing work goals.',
    'Naidhana': 'Naidhana tara: a low day; avoid big risks and travel if you can.',
    'Mitra': 'Mitra tara: good for meeting friends and teamwork.',
    'Parama Mitra': 'Parama Mitra tara: a very supportive day for important tasks.'
  };

  function seasonTips(g) {
    const at = ab => g.list.find(x => x.ab === ab), sa = at('Sa'), out = [];
    if (/Sade Sati/.test(g.sani)) out.push(`Sani: ${g.sani}. Steady effort beats shortcuts; avoid risky investments.`);
    else if (g.sani === 'Ashtama Sani') out.push('Sani: Ashtama Sani. Be patient, look after your health and avoid big risks.');
    else if (g.sani === 'Ardhashtama Sani') out.push('Sani: Ardhashtama Sani. Home and family need extra care; stay patient.');
    else if (sa.good) out.push(`Sani in the ${C.ordinal(sa.house)} supports steady progress and hard work.`);
    out.push(g.guruBalam ? 'Guru balam is with you: a good period for family plans and auspicious events.'
      : 'Guru is not in a strong house: take advice before big commitments.');
    const more = [];
    if (at('Ma').good) more.push('Sevvai gives courage: a good time to tackle tough tasks.'); else more.push('Sevvai is unfavourable: watch your temper and drive carefully.');
    if (at('Su').good) more.push('Suriyan supports recognition at work.');
    if (at('Me').good) more.push('Budhan helps communication, study and paperwork.');
    if (at('Ve').good) more.push('Sukran brings comfort: good for relationships and leisure.');
    if (at('Ra').good || at('Ke').good) more.push(`${at('Ra').good ? 'Rahu' : 'Ketu'} favours bold moves.`);
    out.push(pick(more, 2));
    return out;
  }

  /** One person's reading for the local day starting at d0. Waking hours (6 am to 10 pm) decide the rating. */
  function reading(A, uid, d0) {
    const ch = personChart(A, uid), w0 = new Date(d0.getTime() + 6 * 36e5), w1 = new Date(d0.getTime() + 22 * 36e5);
    const pad = 3 * 864e5, d1 = new Date(d0.getTime() + 864e5);
    const moonSegs = C.moonSegments(A, new Date(d0 - pad), new Date(d1.getTime() + pad)).filter(s => s.end > d0 && s.start < d1);
    const moonHits = C.hits(ch, moonSegs);
    const counted = moonHits.filter(s => overlap(s, w0, w1) >= 2 * 36e5);   // a brief touch in the night does not count
    const keys = counted.flatMap(s => s.why.map(w => `${w.ref}-${w.house}`));
    const chandra = keys.includes('rasi-8');
    const moonBad = counted.length > 0;
    const nakSegs = C.nakSegments(A, new Date(d0 - pad), new Date(d1.getTime() + pad)).filter(s => s.end > d0 && s.start < d1)
      .map(s => ({ ...s, tara: C.tara(ch.nakIdx, s.nak) }));
    const main = nakSegs.reduce((a, b) => overlap(b, w0, w1) > overlap(a, w0, w1) ? b : a);
    const kind = main.tara.kind;
    const score = (moonBad ? -2 : 1) + (kind === 'good' ? 1 : kind === 'bad' ? -1 : -0.5);
    const rating = chandra || score <= -2 ? 'bad' : score >= 2 ? 'good' : 'mixed';
    const g = C.gochara(ch, C.chart(A, new Date(d0.getTime() + 12 * 36e5), 0, 0).planets);
    const moonKey = MOON_ORDER.find(k => keys.includes(k));
    return {
      uid, name: nameOf(uid), rating, chandra, moonSegs, moonHits, nakSegs, tara: main.tara, g,
      tips: [pick(BASE[rating], uid.length), moonKey ? MOON_TIP[moonKey] : pick(MOON_GOOD, 1), TARA_TIP[main.tara.name]],
      season: seasonTips(g)
    };
  }

  function coupleLine(rs) {
    const [a, b] = rs;
    if (a.rating === 'good' && b.rating === 'good') return pick(['A good day to plan something together.', 'Great day for a shared plan, an outing or a joint decision.']);
    if (a.rating === 'bad' && b.rating === 'bad') return 'A sensitive day for you both: be extra patient with each other and keep plans simple.';
    if (a.rating === b.rating) return 'A mixed day for both: keep plans flexible and check in with each other.';
    const [better, other] = WORST[a.rating] < WORST[b.rating] ? [a, b] : [b, a];
    return better.uid === S.user?.uid
      ? `You have the easier day: be patient with ${other.name} and take the lead on plans.`
      : `${better.name} has the easier day: let them take the lead${other.uid === S.user?.uid ? ' and go easy on yourself' : ''}.`;
  }

  function dayInfo(A, d0) {
    const d1 = new Date(d0.getTime() + 864e5), pad = 3 * 864e5;
    const cut = segs => segs.filter(s => s.end > d0 && s.start < d1);
    const me = pair.births[S.user?.uid] || pair.births[pair.members[0]];
    return {
      moon: cut(C.moonSegments(A, new Date(d0 - pad), new Date(d1.getTime() + pad))),
      nak: cut(C.nakSegments(A, new Date(d0 - pad), new Date(d1.getTime() + pad))),
      tithi: cut(C.tithiSegments(A, new Date(d0 - pad), new Date(d1.getTime() + pad))),
      kalam: C.kalams(A, d0, me.lat, me.lon), city: (me.place || '').split(',')[0]
    };
  }
  /** "Thulam until 2:48 am, then Viruchigam" style text for the stretches of one day. */
  const chain = (segs, name, d0, d1) => segs.map((s, i) => i === 0 ? `${name(s)} ${span(s, d0, d1)}`
    : name(s) + (s.end < d1 ? ` until ${timeFmt(s.end)}` : '')).join(', then ');
  const kalamText = k => k ? `Rahu kalam ${timeFmt(k.rahu[0])} – ${timeFmt(k.rahu[1])}` : '';

  const pill = r => h('span', { class: 'pill astro-rate ' + r.rating }, RATING[r.rating]);

  /** Banner at the top of Today. */
  async function banner() {
    const box = document.getElementById('astroAlert');
    if (!box) return;
    if (!pair) { box.hidden = true; return; }
    try {
      const A = await loadLib(), [d0] = today(), rs = pair.members.map(u => reading(A, u, d0)), info = dayInfo(A, d0);
      const worst = rs.reduce((m, r) => Math.max(m, WORST[r.rating]), 0), cls = ['good', 'mixed', 'bad'][worst];
      const chandra = rs.filter(r => r.chandra).map(r => who(r.uid));
      fill(box, h('div', { class: 'astro-banner ' + cls, role: 'status' },
        h('span', { class: 'astro-banner-ico' }, icon(cls === 'good' ? 'circle-check' : 'moon-stars')),
        h('div', null,
          h('b', null, 'Today’s stars'),
          h('ul', null, rs.map(r => h('li', null, h('b', null, who(r.uid)), `: ${RATING[r.rating]} · ${r.tara.name} tara`))),
          h('p', null, `Moon in ${chain(info.moon, s => C.RASI[s.sign], d0, new Date(d0.getTime() + 864e5))}`
            + (chandra.length ? ` · Chandrashtamam for ${chandra.join(' and ')}` : '')
            + (info.kalam ? ` · ${kalamText(info.kalam)}` : ''))),
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => switchTab('astro') }, 'Details')));
      box.hidden = false;
    } catch (err) { box.hidden = true; console.warn(err); }
  }

  /* ---------- 8 am pop-up (shown the first time the app is open at or after 8 am, once a day) ---------- */
  let popTimer = null;

  async function showPopup() {
    const A = await loadLib(), [d0, d1] = today(), rs = pair.members.map(u => reading(A, u, d0)), info = dayInfo(A, d0);
    const worst = rs.reduce((m, r) => Math.max(m, WORST[r.rating]), 0), cls = ['good', 'mixed', 'bad'][worst];
    const me = S.user?.uid;
    rs.sort((a, b) => (a.uid === me ? -1 : b.uid === me ? 1 : 0));
    const close = () => overlay.remove();
    const overlay = h('div', { class: 'modal-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Today’s stars' },
      h('div', { class: 'card notice-modal astro-pop' },
        h('div', { class: 'notice-ico ' + (cls === 'good' ? 'good' : cls === 'bad' ? 'warn' : 'mixed') }, icon(cls === 'good' ? 'sun' : 'moon-stars')),
        h('h2', null, cls === 'good' ? 'A good day for you both' : cls === 'bad' ? 'Go gently today' : 'A mixed day'),
        h('p', { class: 'sub astro-pop-moon' }, `Moon in ${chain(info.moon, s => C.RASI[s.sign], d0, d1)} · ${chain(info.nak, s => C.NAK[s.nak], d0, d1)}`),
        h('div', { class: 'astro-pop-people' }, rs.map(r => h('div', { class: 'astro-pop-person ' + r.rating },
          h('div', { class: 'astro-pop-head' }, h('b', null, who(r.uid)), pill(r)),
          h('ul', null, r.tips.slice(1).map(t => h('li', null, t)))))),
        h('p', { class: 'astro-pop-advice' }, coupleLine(rs)),
        info.kalam ? h('p', { class: 'sub' }, `${kalamText(info.kalam)} (${info.city}): avoid starting important work then.`) : null,
        h('div', { class: 'notice-actions' },
          h('button', { class: 'btn ghost', onclick: () => { close(); switchTab('astro'); } }, 'Full reading'),
          h('button', { class: 'btn primary', onclick: close }, 'Got it'))));
    document.body.append(overlay);
  }

  /** Shows the pop-up once a day, the first time the app is open at or after 8 am. Waits for other pop-ups to close. */
  function schedulePopup() {
    clearTimeout(popTimer);
    if (!pair || !S.user || S.user.role === 'admin') return;
    const now = new Date(), eight = new Date(now); eight.setHours(8, 0, 0, 0);
    if (now < eight) { popTimer = setTimeout(schedulePopup, eight - now + 1000); return; }
    const key = 'astroPop.' + S.user.uid;
    if (store.get(key, '') === todayKey()) return;
    if (document.querySelector('.modal-overlay')) { popTimer = setTimeout(schedulePopup, 1500); return; }
    store.set(key, todayKey());
    showPopup().catch(err => console.warn(err));
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { schedulePopup(); if (S.tab === 'log') banner(); } });

  /* ---------- member view ---------- */
  function personDay(r, d0, d1) {
    return h('div', { class: 'card astro-day ' + r.rating },
      h('div', { class: 'card-head' }, h('h2', null, r.uid === S.user?.uid ? `You (${r.name})` : r.name), pill(r)),
      h('ul', { class: 'astro-tips' }, r.tips.map(t => h('li', null, t))),
      h('dl', { class: 'astro-facts' },
        h('dt', null, 'Moon'), h('dd', null, r.moonSegs.map(s => {
          const hit = r.moonHits.find(x => x.start.getTime() === s.start.getTime());
          return h('span', { class: 'astro-seg ' + (hit ? 'bad' : 'good') }, `${C.RASI[s.sign]} ${span(s, d0, d1)}`,
            hit ? ` (${hit.why.map(C.label).join(', ')})` : ' (good)');
        })),
        h('dt', null, 'Tara'), h('dd', null, r.nakSegs.map(s => h('span', { class: 'astro-seg ' + (s.tara.kind === 'bad' ? 'bad' : s.tara.kind === 'good' ? 'good' : 'mixed') },
          `${s.tara.name} (${C.NAK[s.nak]}) ${span(s, d0, d1)}`)))),
      h('h3', { class: 'astro-h3' }, 'Planets now (from your rasi)'),
      h('div', { class: 'astro-chips' }, r.g.list.map(x => h('span', { class: 'astro-chip ' + (x.good ? 'good' : 'bad'), title: `${PL[x.ab]} in ${C.RASI[x.sign]}, ${C.ordinal(x.house)} from rasi` },
        `${PL[x.ab]} ${C.ordinal(x.house)}${x.retro ? ' ®' : ''}`))),
      r.g.sani ? h('p', { class: 'astro-sani' }, icon('alert-circle'), ' ', r.g.sani) : null,
      h('ul', { class: 'astro-tips season' }, r.season.map(t => h('li', null, t))));
  }

  async function renderMember(body) {
    if (!pair) return fill(body, h('div', { class: 'empty' }, icon('moon-stars'), h('p', null, 'No charts yet. The admin links two people and adds their birth details.')));
    fill(body, h('p', { class: 'sub' }, 'Working out today’s reading…'));
    let A;
    try { A = await loadLib(); } catch (err) { return fill(body, h('p', { class: 'sub err' }, err.message)); }
    const now = new Date(), nowSign = C.signOf(C.moonLon(A, now)), [d0, d1] = today();
    const info = dayInfo(A, d0), me = S.user?.uid;
    const rs = pair.members.map(u => reading(A, u, d0)).sort((a, b) => (a.uid === me ? -1 : b.uid === me ? 1 : 0));
    const k = info.kalam;

    const todayCard = h('div', { class: 'card astro-today' },
      h('div', { class: 'card-head' }, h('h2', null, icon('calendar-event'), ' ', now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }))),
      h('dl', { class: 'astro-facts' },
        h('dt', null, 'Moon'), h('dd', null, chain(info.moon, s => C.RASI[s.sign], d0, d1)),
        h('dt', null, 'Nakshatra'), h('dd', null, chain(info.nak, s => C.NAK[s.nak], d0, d1)),
        h('dt', null, 'Tithi'), h('dd', null, chain(info.tithi, s => C.tithiName(s.tithi), d0, d1)),
        k ? [h('dt', null, 'Sun'), h('dd', null, `rises ${timeFmt(k.sunrise)}, sets ${timeFmt(k.sunset)}`),
          h('dt', null, 'Rahu kalam'), h('dd', null, `${timeFmt(k.rahu[0])} – ${timeFmt(k.rahu[1])}`),
          h('dt', null, 'Yamagandam'), h('dd', null, `${timeFmt(k.yama[0])} – ${timeFmt(k.yama[1])}`),
          h('dt', null, 'Kuligai'), h('dd', null, `${timeFmt(k.kuli[0])} – ${timeFmt(k.kuli[1])}`)] : null),
      k ? h('p', { class: 'sub' }, `Times for ${info.city}. Avoid starting important work in Rahu kalam and Yamagandam.`) : null);

    const coupleCard = h('div', { class: 'card astro-couple' },
      h('div', { class: 'card-head' }, h('h2', null, icon('heart'), ' Together today')),
      h('div', { class: 'astro-couple-rates' }, rs.map(r => h('div', null, h('b', null, who(r.uid)), pill(r)))),
      h('p', { class: 'astro-pop-advice' }, coupleLine(rs)));

    fill(body,
      h('div', { class: 'astro-top' }, todayCard, h('div', { class: 'astro-stack' }, coupleCard)),
      h('div', { class: 'astro-charts' }, rs.map(r => personDay(r, d0, d1))),
      h('h2', { class: 'astro-section' }, 'Birth charts'),
      h('div', { class: 'astro-charts' }, rs.map(r => chartCard(A, r.uid, nowSign))),
      h('p', { class: 'sub astro-note' }, 'Sidereal positions with Lahiri ayanamsa, mean Rahu/Ketu. The day’s rating comes from the Moon (1st, 7th or 8th from rasi or lagna) and Tara balam during waking hours; the other planets are counted from the birth rasi and shape the advice. Times are in your device’s time zone.'));
  }

  /* ---------- admin view ---------- */
  function placeField(prefill) {
    const st = { ...(prefill || {}) };
    const input = h('input', { type: 'text', placeholder: 'Start typing a city, e.g. Chennai', value: st.place || '', autocomplete: 'off', required: true });
    const list = h('div', { class: 'astro-places', hidden: true });
    const manual = h('details', { class: 'astro-manual' }, h('summary', null, 'Enter coordinates by hand'),
      h('div', { class: 'astro-coords' },
        h('label', null, 'Latitude', h('input', { type: 'number', step: 'any', min: '-90', max: '90', value: st.lat ?? '', 'data-k': 'lat' })),
        h('label', null, 'Longitude', h('input', { type: 'number', step: 'any', min: '-180', max: '180', value: st.lon ?? '', 'data-k': 'lon' })),
        h('label', null, 'Time zone', h('input', { type: 'text', value: st.tz || 'Asia/Kolkata', 'data-k': 'tz', placeholder: 'Asia/Kolkata' }))));
    const hint = h('p', { class: 'sub astro-picked' }, st.lat != null ? `${(+st.lat).toFixed(2)}, ${(+st.lon).toFixed(2)} · ${st.tz}` : '');
    const setManual = () => { for (const i of manual.querySelectorAll('input')) i.value = st[i.dataset.k] ?? (i.dataset.k === 'tz' ? 'Asia/Kolkata' : ''); };
    manual.addEventListener('input', e => {
      const k = e.target.dataset.k; if (!k) return;
      st[k] = k === 'tz' ? e.target.value.trim() : (e.target.value === '' ? null : Number(e.target.value));
      hint.textContent = st.lat != null && st.lon != null ? `${(+st.lat).toFixed(2)}, ${(+st.lon).toFixed(2)} · ${st.tz || ''}` : '';
    });
    let timer = null, seq = 0;
    input.addEventListener('input', () => {
      st.place = input.value.trim(); st.lat = st.lon = null; hint.textContent = '';
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { list.hidden = true; return; }
      timer = setTimeout(async () => {
        const my = ++seq;
        try {
          const r = await fetch(`${GEO}?name=${encodeURIComponent(q)}&count=6&language=en&format=json`);
          const j = await r.json();
          if (my !== seq) return;
          const res = (j.results || []).filter(x => x.timezone);
          fill(list, res.length ? res.map(x => h('button', { type: 'button', class: 'astro-place', onclick: () => {
            Object.assign(st, { place: [x.name, x.admin1, x.country].filter(Boolean).join(', '), lat: x.latitude, lon: x.longitude, tz: x.timezone });
            input.value = st.place; list.hidden = true; setManual();
            hint.textContent = `${x.latitude.toFixed(2)}, ${x.longitude.toFixed(2)} · ${x.timezone}`;
          } }, h('b', null, x.name), ' ', h('span', { class: 'muted' }, [x.admin1, x.country].filter(Boolean).join(', '))))
            : h('p', { class: 'sub' }, 'No match. Try another spelling, or enter coordinates by hand.'));
          list.hidden = false;
        } catch { if (my === seq) { fill(list, h('p', { class: 'sub' }, 'City search is not available. Enter coordinates by hand below.')); list.hidden = false; } }
      }, 300);
    });
    return { el: h('div', { class: 'astro-place-field' }, h('label', null, 'Birth place', input), list, hint, manual), get: () => st };
  }

  function personFields(label, members, taken, prefill) {
    const sel = h('select', { required: true },
      h('option', { value: '' }, 'Choose a person'),
      members.map(m => h('option', { value: m.uid, disabled: taken.has(m.uid) && m.uid !== prefill?.uid }, m.userName + (taken.has(m.uid) && m.uid !== prefill?.uid ? ' (already linked)' : ''))));
    if (prefill?.uid) sel.value = prefill.uid;
    const b = prefill?.birth || {};
    const date = h('input', { type: 'date', required: true, value: b.date || '', max: todayKey() });
    const time = h('input', { type: 'time', required: true, value: b.time || '' });
    const place = placeField(b);
    return {
      el: h('fieldset', { class: 'astro-person-form' }, h('legend', null, label),
        h('label', null, 'Person', sel), h('div', { class: 'astro-row' }, h('label', null, 'Birth date', date), h('label', null, 'Birth time', time)), place.el),
      get() {
        const p = place.get();
        return { uid: sel.value, birth: { date: date.value, time: time.value, place: p.place || '', lat: p.lat, lon: p.lon, tz: p.tz || '' } };
      }
    };
  }

  function validBirth(b, who) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return `Enter ${who}'s birth date.`;
    if (!/^\d{2}:\d{2}$/.test(b.time)) return `Enter ${who}'s birth time.`;
    if (!b.place) return `Enter ${who}'s birth place.`;
    if (!(Math.abs(b.lat) <= 90) || !(Math.abs(b.lon) <= 180) || b.lat === null || b.lon === null) return `Pick ${who}'s birth place from the list (or enter coordinates by hand).`;
    try { new Intl.DateTimeFormat('en-US', { timeZone: b.tz }); } catch { return `${who}'s time zone "${b.tz}" is not recognised.`; }
    return '';
  }

  async function renderAdmin(body) {
    fill(body, h('p', { class: 'sub' }, 'Loading…'));
    let members;
    try {
      [members, pairs] = await Promise.all([Account.listMembers(), Account.listAstroPairs()]);
    } catch (err) { return fill(body, h('p', { class: 'sub err' }, err.message)); }
    members = members.filter(m => !m.deleted && m.role !== 'admin');
    const nameOf = uid => members.find(m => m.uid === uid)?.userName;
    let editing = null;

    const draw = () => {
      const taken = new Set(pairs.filter(p => p.id !== editing?.id).flatMap(p => p.members));
      const pre = i => editing ? { uid: editing.members[i], birth: editing.births[editing.members[i]] } : null;
      const a = personFields('First person', members, taken, pre(0)), b = personFields('Second person', members, taken, pre(1));
      const status = h('p', { class: 'sub' });
      const form = h('form', { class: 'card settings wide astro-admin-form', onsubmit: async e => {
        e.preventDefault();
        const pa = a.get(), pb = b.get();
        if (!pa.uid || !pb.uid) return toast('Choose both people.', true);
        if (pa.uid === pb.uid) return toast('Choose two different people.', true);
        const err = validBirth(pa.birth, nameOf(pa.uid) || 'the first person') || validBirth(pb.birth, nameOf(pb.uid) || 'the second person');
        if (err) return toast(err, true);
        const btn = form.querySelector('button[type=submit]'); btn.disabled = true; status.textContent = 'Saving…';
        try {
          await Account.saveAstroPair(editing?.id || null, {
            members: [pa.uid, pb.uid],
            names: { [pa.uid]: nameOf(pa.uid), [pb.uid]: nameOf(pb.uid) },
            births: { [pa.uid]: pa.birth, [pb.uid]: pb.birth },
            by: S.user.userName
          });
          toast(editing ? 'Charts updated' : `${nameOf(pa.uid)} and ${nameOf(pb.uid)} are linked`);
          editing = null;
          pairs = await Account.listAstroPairs(); draw();
        } catch (err2) { status.textContent = ''; btn.disabled = false; toast(err2.message, true); }
      } },
        h('h2', null, editing ? 'Edit birth details' : 'Link two people'),
        h('p', { class: 'sub' }, 'Only these two people (and you) will see the charts. Each sees both charts and gets a Moon alert on Today.'),
        h('div', { class: 'astro-pair-form' }, a.el, b.el),
        h('div', { class: 'row-actions' },
          editing ? h('button', { type: 'button', class: 'btn ghost', onclick: () => { editing = null; draw(); } }, 'Cancel') : null,
          h('span', { class: 'spacer' }),
          h('button', { type: 'submit', class: 'btn primary' }, icon(editing ? 'device-floppy' : 'link'), editing ? ' Save' : ' Link and save')),
        status);

      const list = h('div', { class: 'card settings wide' }, h('h2', null, 'Linked couples'),
        pairs.length ? h('div', { class: 'rows' }, pairs.map(p => h('div', { class: 'row' },
          h('div', { class: 'who' }, h('b', null, p.members.map(u => nameOf(u) || p.names?.[u] || 'Removed member').join(' & ')),
            h('div', { class: 'muted' }, p.members.map(u => p.births?.[u]?.place?.split(',')[0] || '').join(' · '))),
          h('button', { class: 'btn small ghost', onclick: () => { editing = p; draw(); body.scrollIntoView({ behavior: 'smooth' }); } }, icon('pencil'), 'Edit'),
          h('button', { class: 'btn small ghost', onclick: () => preview(p, previewBox) }, icon('eye'), 'Charts'),
          h('button', { class: 'btn small', onclick: async () => {
            if (!confirm(`Unlink ${p.members.map(u => nameOf(u) || p.names?.[u]).join(' and ')}? Their birth details are deleted.`)) return;
            try { await Account.deleteAstroPair(p.id); pairs = pairs.filter(x => x.id !== p.id); if (editing?.id === p.id) editing = null; draw(); toast('Unlinked'); } catch (err) { toast(err.message, true); }
          } }, icon('unlink'), 'Unlink'))))
          : h('p', { class: 'sub' }, 'No one linked yet.'));
      const previewBox = h('div', { class: 'astro-preview' });
      fill(body, h('div', { class: 'settings-grid' }, form, list), previewBox);
    };
    draw();
  }

  async function preview(p, box) {
    fill(box, h('p', { class: 'sub' }, 'Working out the charts…'));
    try {
      const A = await loadLib(), keep = pair;
      pair = p;
      try {
        const nowSign = C.signOf(C.moonLon(A, new Date()));
        fill(box, h('div', { class: 'astro-charts' }, p.members.map(uid => chartCard(A, uid, nowSign))));
      } finally { pair = keep; }
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) { fill(box, h('p', { class: 'sub err' }, err.message)); }
  }

  /* ---------- wiring ---------- */
  return {
    /** After sign-in: find this person's pair, show or hide the tab, and draw the Today banner. */
    async onSignIn(profile) {
      pair = null; loaded = false;
      const nav = document.getElementById('navAstro');
      if (profile.role === 'admin') { if (nav) nav.hidden = false; loaded = true; return; }
      try { pair = await Account.myAstroPair(profile.uid); } catch (err) { console.warn('Could not read charts (are the Firestore rules published?)', err); }
      loaded = true;
      if (nav) nav.hidden = !pair;
      banner();
      // let the admin message and upload pop-ups (shown just after sign-in) go first
      clearTimeout(popTimer); popTimer = setTimeout(schedulePopup, 6000);
    },
    reset() {
      clearTimeout(popTimer);
      pair = null; pairs = []; loaded = false;
      const nav = document.getElementById('navAstro'); if (nav) nav.hidden = true;
      const box = document.getElementById('astroAlert'); if (box) box.hidden = true;
    },
    banner,
    render() {
      const body = document.getElementById('astroBody');
      if (!body) return;
      const admin = S.user?.role === 'admin';
      document.getElementById('astroSub').textContent = admin
        ? 'Link two people and add their birth details. Only they see their charts and Moon alerts.'
        : 'How today looks for both of you, from the Moon, Tara balam and the other planets, plus your birth charts.';
      return admin ? renderAdmin(body) : renderMember(body);
    }
  };
})();
