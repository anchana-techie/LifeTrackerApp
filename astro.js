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
      asc, lagna: signOf(asc), rasi: planets.Mo.sign, planets,
      nakshatra: NAK[nakIdx], pada: Math.floor((moon % (360 / 27)) / (360 / 108)) + 1
    };
  }

  /** Splits [from, to] into stretches with one Moon sign each, finding each change to within a minute. */
  function moonSegments(A, from, to) {
    const out = [], step = 2 * 3600e3;
    let a = from.getTime(), sa = signOf(moonLon(A, from));
    for (let b = a + step; ; b += step) {
      const end = Math.min(b, to.getTime()), sb = signOf(moonLon(A, new Date(end)));
      if (sb !== sa) {
        let lo = end - step < a ? a : end - step, hi = end;
        while (hi - lo > 60e3) { const mid = (lo + hi) / 2; if (signOf(moonLon(A, new Date(mid))) === sa) lo = mid; else hi = mid; }
        out.push({ sign: sa, start: new Date(a), end: new Date(hi) });
        a = hi; sa = sb;
      }
      if (end >= to.getTime()) break;
    }
    out.push({ sign: sa, start: new Date(a), end: new Date(to.getTime()) });
    return out;
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

  return { RASI, RASI_EN, NAK, PLANETS, WATCH, signOf, houseFrom, ordinal, ayanamsa, moonLon, ascendant, chart, moonSegments, hits, label, birthMoment, tzOffsetMin };
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
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
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

  /* ---------- couple timeline ---------- */
  const who = p => p.uid === S.user?.uid ? 'You' : p.name;
  const hitText = x => `${who(x)}: ${x.why.map(C.label).join(', ')}`;

  /** Every Moon stretch overlapping [from, to] and who it hits: [{ sign, start, end, hits: [{ uid, name, why }] }].
   *  An empty hits list means the stretch is clear for both people. */
  function timeline(A, from, to) {
    // start three days early so a stretch already running at `from` shows its real start time
    // and run three days past `to` so the last stretch shows its real end time
    const segs = C.moonSegments(A, new Date(from.getTime() - 3 * 864e5), new Date(to.getTime() + 3 * 864e5)).filter(s => s.end > from && s.start < to);
    const people = pair.members.map(uid => ({ uid, name: pair.names[uid] || 'Person', ch: personChart(A, uid) }));
    return segs.map(s => ({ ...s, hits: people.map(p => { const x = C.hits(p.ch, [s])[0]; return x ? { uid: p.uid, name: p.name, why: x.why } : null; }).filter(Boolean) }));
  }
  const today = () => { const d0 = startOfDay(new Date()); return [d0, new Date(d0.getTime() + 864e5)]; };

  /** Banner at the top of Today: red when the Moon is in a 1st/7th/8th for either person today, green otherwise. */
  async function banner() {
    const box = document.getElementById('astroAlert');
    if (!box) return;
    if (!pair) { box.hidden = true; return; }
    try {
      const A = await loadLib(), [d0, d1] = today(), tl = timeline(A, d0, d1);
      const bad = tl.some(s => s.hits.length);
      fill(box, h('div', { class: 'astro-banner ' + (bad ? 'bad' : 'good'), role: 'status' },
        h('span', { class: 'astro-banner-ico' }, icon(bad ? 'moon-stars' : 'circle-check')),
        h('div', null,
          h('b', null, bad ? 'Moon watch today' : 'All clear today'),
          bad
            ? h('ul', null, tl.map(s => h('li', null, h('b', null, `${C.RASI[s.sign]}, ${whenText(s, d0, d1)}`), ': ',
              s.hits.length ? s.hits.map(hitText).join(' · ') : 'clear for both of you')))
            : h('p', null, `Moon in ${tl.map(s => C.RASI[s.sign]).join(', then ')} is good for both of you.`)),
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => switchTab('astro') }, 'Charts')));
      box.hidden = false;
    } catch (err) { box.hidden = true; console.warn(err); }
  }

  /* ---------- 8 am pop-up (shown the first time the app is open after 8 am, once a day) ---------- */
  const ADVICE = {
    clear: [
      'The Moon is favourable for both of you today. A good day to plan things together or start something new.',
      'All clear for you both. Good for outings, decisions and getting things done as a team.',
      'A smooth Moon for both of you. Use the easy energy to tick off something you have been putting off.',
      'Good vibes for both of you today. Make time for each other and be generous with plans.'
    ],
    self: [
      'You may feel more sensitive today. Keep plans light and be easy on yourself.',
      'A low-energy Moon for you. Rest well, skip heated topics and hold off on big decisions.',
      'Your Moon is in a tricky spot. Keep the day simple and let small things slide.',
      'Take it slow today. Avoid arguments and leave major choices for a clearer day.'
    ],
    partner: [
      '{name} may feel more sensitive today. Be patient and keep plans light together.',
      'Go gently with {name} today. Avoid arguments; small kindnesses go a long way.',
      'A low-energy day for {name}. Give some space and skip heated topics.',
      '{name}’s Moon is in a tricky spot. Offer support and save big decisions for later.'
    ],
    both: [
      'A sensitive day for both of you. Keep plans simple, avoid arguments and postpone big decisions.',
      'You may both feel a bit off today. Be extra patient with each other and get good rest.',
      'The Moon is in a tough spot for you both. Slow down, skip heated topics and save big plans for a clearer day.'
    ]
  };
  let popTimer = null;

  function popupContent(A) {
    const now = new Date(), [d0, d1] = today(), tl = timeline(A, now, d1);
    const hit = new Map();
    tl.forEach(s => s.hits.forEach(x => {
      const p = hit.get(x.uid) || { ...x, chandra: false };
      p.chandra ||= x.why.some(w => w.ref === 'rasi' && w.house === 8);
      hit.set(x.uid, p);
    }));
    const day = Math.round(d0.getTime() / 864e5), pick = (arr, salt = 0) => arr[(day + salt) % arr.length];
    const people = [...hit.values()], me = S.user?.uid;
    const advice = !people.length ? pick(ADVICE.clear)
      : people.length === 2 ? pick(ADVICE.both)
      : people[0].uid === me ? pick(ADVICE.self) : pick(ADVICE.partner, 1).replace('{name}', people[0].name);
    const chandra = people.filter(p => p.chandra);
    const chandraLine = chandra.length
      ? `Chandrashtamam for ${chandra.map(p => p.uid === me ? 'you' : p.name).join(' and ')}: if you can, avoid starting anything new, long travel or signing important papers.`
      : '';
    let next = null;
    if (people.length) next = timeline(A, now, new Date(now.getTime() + 7 * 864e5)).find(s => !s.hits.length && s.start > now);
    return { tl, d0, d1, bad: people.length > 0, advice, chandraLine, next };
  }

  async function showPopup() {
    const A = await loadLib(), c = popupContent(A);
    const close = () => overlay.remove();
    const overlay = h('div', { class: 'modal-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Today’s Moon' },
      h('div', { class: 'card notice-modal astro-pop' },
        h('div', { class: 'notice-ico' + (c.bad ? ' warn' : ' good') }, icon(c.bad ? 'moon-stars' : 'sun')),
        h('h2', null, c.bad ? 'Go gently today' : 'All clear today'),
        h('ul', { class: 'astro-pop-list' }, c.tl.map(s => h('li', { class: s.hits.length ? 'bad' : 'good' },
          h('b', null, `Moon in ${C.RASI[s.sign]}`), ` (${C.RASI_EN[s.sign]}) ${whenText(s, new Date(), c.d1)}`,
          h('span', null, s.hits.length ? s.hits.map(hitText).join(' · ') : 'Clear for both of you')))),
        h('p', { class: 'astro-pop-advice' }, c.advice),
        c.chandraLine ? h('p', { class: 'astro-pop-chandra' }, c.chandraLine) : null,
        c.next ? h('p', { class: 'sub' }, `Next clear stretch for both: ${dayFmt(c.next.start)}, ${timeFmt(c.next.start)}`) : null,
        h('div', { class: 'notice-actions' },
          h('button', { class: 'btn ghost', onclick: () => { close(); switchTab('astro'); } }, 'See charts'),
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
  async function renderMember(body) {
    if (!pair) return fill(body, h('div', { class: 'empty' }, icon('moon-stars'), h('p', null, 'No charts yet. The admin links two people and adds their birth details.')));
    fill(body, h('p', { class: 'sub' }, 'Working out the charts…'));
    let A;
    try { A = await loadLib(); } catch (err) { return fill(body, h('p', { class: 'sub err' }, err.message)); }
    const now = new Date(), nowSign = C.signOf(C.moonLon(A, now)), moon = C.moonLon(A, now);
    const segNow = C.moonSegments(A, now, new Date(now.getTime() + 3 * 864e5))[0];
    const d0 = startOfDay(now), week = timeline(A, d0, new Date(d0.getTime() + 7 * 864e5));

    const moonCard = h('div', { class: 'card astro-today' },
      h('div', { class: 'card-head' }, h('h2', null, icon('moon'), ' Moon now')),
      h('p', { class: 'astro-big' }, `${C.RASI[nowSign]} `, h('span', { class: 'muted' }, `(${C.RASI_EN[nowSign]})`)),
      h('p', { class: 'sub' }, `${C.NAK[Math.floor(moon / (360 / 27))]} nakshatra · moves to ${C.RASI[(nowSign + 1) % 12]} on ${dayFmt(segNow.end)}, ${timeFmt(segNow.end)}`));

    const watchCard = h('div', { class: 'card astro-watch' },
      h('div', { class: 'card-head' }, h('h2', null, 'Moon timeline · next 7 days')),
      h('p', { class: 'sub' }, h('span', { class: 'astro-key bad' }), ' Moon in the 1st, 7th or 8th from a rasi or lagna of either of you · ',
        h('span', { class: 'astro-key good' }), ' clear for both'),
      h('ul', { class: 'astro-list' }, week.map(s => {
        const active = s.start <= now && s.end > now;
        return h('li', { class: (s.hits.length ? 'bad' : 'good') + (active ? ' on' : '') },
          h('div', { class: 'astro-li-head' },
            h('span', { class: 'astro-when' }, sameDay(s.start, s.end)
              ? `${dayFmt(s.start)}, ${timeFmt(s.start)} – ${timeFmt(s.end)}`
              : `${dayFmt(s.start)} ${timeFmt(s.start)} → ${dayFmt(s.end)} ${timeFmt(s.end)}`),
            active ? h('span', { class: 'pill' }, 'now') : null),
          h('b', null, `Moon in ${C.RASI[s.sign]}`),
          s.hits.length ? s.hits.map(x => h('span', { class: 'astro-hit' }, hitText(x))) : h('span', { class: 'astro-hit' }, 'Good for both of you'));
      })));

    fill(body,
      h('div', { class: 'astro-top' }, moonCard, watchCard),
      h('div', { class: 'astro-charts' }, pair.members.map(uid => chartCard(A, uid, nowSign))),
      h('p', { class: 'sub astro-note' }, 'Sidereal positions with Lahiri ayanamsa, mean Rahu/Ketu. Times are in your device’s time zone.'));
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
        : 'Both your charts, and when the Moon is in the 1st, 7th or 8th from a rasi or lagna.';
      return admin ? renderAdmin(body) : renderMember(body);
    }
  };
})();
