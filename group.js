/* Admin "Everyone" views: compare all members on Today, Buy list and Insights.
 * Loads each member's file for the chosen year (read-only), reuses the single-person analysis
 * by pointing S.data / S.idx at one member at a time, and keeps only a small summary per person.
 */
'use strict';

const PALETTE = ['#1D9E75', '#D4537E', '#2F8FE0', '#E0784F', '#8E6BD8', '#C9A227', '#4CB5AE', '#B5539A'];
const people = n => n === 1 ? '1 person' : `${n} people`;
const pc = v => v === null || v === undefined || isNaN(v) ? '—' : Math.round(v * 100) + '%';
const trendMark = (a, b) => a == null || b == null ? '' : a - b > 0.02 ? '▲' : a - b < -0.02 ? '▼' : '≈';
const G_RANGES = [['today', 'Today'], ['7', 'Last 7 days'], ['30', 'Last 30 days']];

/* =========================================================
 * Per-person summary
 * ======================================================= */
function withMember(data, fn) {
  const keep = { data: S.data, idx: S.idx };
  try {
    data.profile ||= { height: null, waterGoal: null, tumbler: null };
    data.water ||= { days: {} };
    S.data = data; buildIndex();
    return fn();
  } finally { S.data = keep.data; S.idx = keep.idx; }
}

function memberStats(data) {
  return withMember(data, () => {
    const ix = S.idx, t = todayKey();
    const kinds = ['dos', 'habits'].filter(k => ix[k]);
    const total = kinds.reduce((s, k) => s + ix[k].items.length, 0);
    const logged = new Set(kinds.flatMap(k => [...ix[k].loggedDays]));
    const doneOn = d => kinds.reduce((s, k) => s + ix[k].items.filter(n => ix[k].sets[n].has(d)).length, 0);
    const pctOn = d => total ? doneOn(d) / total : 0;
    const avgOver = (a, b) => { const v = rangeDays(a, b).filter(d => logged.has(d)).map(pctOn); return v.length ? mean(v) : null; };
    const w30 = rangeDays(addDays(t, -29), t);

    const lastLogged = [...logged].filter(d => d <= t).sort().pop() || null;
    const dowAvg = Array.from({ length: 7 }, (_, w) => {
      const v = rangeDays(addDays(t, -59), t).filter(d => logged.has(d) && dow(d) === w).map(pctOn);
      return v.length ? mean(v) : null;
    });

    return {
      total, lastLogged,
      todayPct: logged.has(t) ? pctOn(t) : null, todayDone: logged.has(t) ? doneOn(t) : null,
      d7: avgOver(addDays(t, -6), t), p7: avgOver(addDays(t, -13), addDays(t, -7)),
      d30: avgOver(addDays(t, -29), t), p30: avgOver(addDays(t, -59), addDays(t, -30)),
      logged30: w30.filter(d => logged.has(d)).length,
      streak: streakEnding(logged, logged.has(t) ? t : addDays(t, -1)),
      series: w30.map(d => logged.has(d) ? pctOn(d) : null),
      dowAvg
    };
  });
}

/* =========================================================
 * Loading
 * ======================================================= */
async function enterGroup() {
  S.viewUid = 'all'; S.demo = false; S.groupMode = true;
  S.data = null; S.idx = null; S.readOnly = false; S.group = null; S.gMonths = null;
  document.body.classList.remove('readonly');
  $$('[data-sheet-title]').forEach(e => { e.textContent = 'Everyone'; });
  $('#banner').hidden = true;
  destroyCharts();
  await refreshYears();
  fillUserSelect();
  await loadGroup();
}

async function loadGroup() {
  if (!S.year) { S.group = null; renderTab(); return; }
  const year = S.year, btn = $('#loadBtn');
  btn.disabled = true; btn.textContent = 'Loading…';
  setLoader(true);
  try {
    const people = S.members.filter(m => (S.memberYears[m.uid] || []).some(r => r.year === year));
    const rows = [], failed = [];
    for (const m of people) {   // one at a time: the script handles one request at once
      try {
        const data = await api('read', { year, asUid: m.uid });
        if (m.gender === 'male') data.sheets.period = null;
        rows.push({ uid: m.uid, name: m.userName, gender: m.gender, color: PALETTE[rows.length % PALETTE.length], st: memberStats(data) });
      } catch (err) { failed.push(`${m.userName}: ${err.message}`); }
    }
    S.group = { year, rows, failed, loadedAt: new Date() };
    S.gMonths = null;
    renderTab();
    if (failed.length) toast(`Could not load ${failed.length} ${failed.length === 1 ? 'person' : 'people'}: ${failed[0]}`, true);
  } catch (err) { toast(err.message, true); }
  finally { btn.disabled = false; btn.textContent = 'Load'; setLoader(false); }
}

/* =========================================================
 * Shared bits
 * ======================================================= */
function groupHost(tab) {
  const panel = $('#tab-' + tab);
  $$('[data-empty], [data-ready]', panel).forEach(e => { e.hidden = true; });
  let box = $('.grp', panel);
  if (!box) { box = h('div', { class: 'grp' }); panel.append(box); }
  box.hidden = false;
  return box;
}

function renderGroupTab(tab) {
  destroyCharts();
  const box = groupHost(tab);
  const G = S.group;
  if (!S.year || !G) { fill(box, h('div', { class: 'empty' }, icon('users'), h('p', null, S.year ? 'Loading everyone…' : 'Nobody has uploaded a file yet. Members upload their own years from the Upload tab.'))); return; }
  if (!G.rows.length) { fill(box, h('div', { class: 'empty' }, icon('users'), h('p', null, `Nobody has a file for ${G.year}. Pick another year above.`))); return; }
  const view = ({ log: groupToday, analysis: groupInsights })[tab];
  if (view) view(box, G);
}

function groupHead(title, sub, extra) {
  return h('div', { class: 'log-head' }, h('div', null, h('h1', null, title), h('p', { class: 'sub' }, sub)),
    h('div', { class: 'head-actions' }, extra, h('button', { class: 'btn small ghost', onclick: () => loadGroup() }, icon('refresh'), 'Refresh')));
}

const dot = c => h('span', { class: 'pdot', style: `background:${c}` });
const gcard = (title, sub, ...kids) => h('div', { class: 'card', style: 'margin-bottom:16px' }, h('h2', null, title), sub ? h('p', { class: 'sub' }, sub) : null, ...kids);

function groupChart(parent, type, labels, datasets, opts = {}) {
  const cv = h('canvas');
  parent.append(h('div', { class: 'chart-box' + (opts.tall ? ' tall' : '') }, cv));
  chart(cv, { type, data: { labels, datasets }, options: opts.options || {} });
}

function table(head, rows) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', null, h('tr', null, head.map(x => h('th', null, x)))),
    h('tbody', null, rows.map(r => h('tr', null, r.map((c, i) => h('td', i === 0 ? { class: 'name' } : null, c)))))));
}

const pctSeries = a => a.map(v => v === null ? null : +(v * 100).toFixed(1));
const last30Labels = () => rangeDays(addDays(todayKey(), -29), todayKey()).map(d => fmt(d));
const pctAxis = { y: { min: 0, max: 100, ticks: { callback: v => v + '%' } }, x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } } };

/* =========================================================
 * TODAY — everyone side by side
 * ======================================================= */
function groupToday(box, G) {
  S.gRange ||= G.rows.some(r => r.st.todayPct !== null) ? 'today' : '7';   // nobody logged yet today -> show the week
  const val = r => S.gRange === 'today' ? r.st.todayPct : S.gRange === '7' ? r.st.d7 : r.st.d30;
  const rangeName = G_RANGES.find(([v]) => v === S.gRange)[1].toLowerCase();
  const ranked = [...G.rows].sort((a, b) => (val(b) ?? -1) - (val(a) ?? -1));
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Period' }, G_RANGES.map(([v, l]) =>
    h('button', { 'aria-pressed': String(S.gRange === v), onclick: () => { S.gRange = v; renderGroupTab('log'); } }, l)));

  const cards = h('div', { class: 'grp-cards' }, ranked.map((r, i) => {
    const s = r.st, v = val(r);
    const kv = (k, x) => h('div', { class: 'kv' }, h('span', null, k), h('b', null, x));
    return h('div', { class: 'card pcard', style: `--pc:${r.color}` },
      h('div', { class: 'pc-head' }, dot(r.color), h('b', null, r.name), h('span', { class: 'rank' }, '#' + (i + 1))),
      h('div', { class: 'pc-body' },
        h('div', { class: 'big-ring', style: `background:${ringBg(v || 0)}` }, h('div', null, pc(v))),
        h('div', { class: 'pc-stats' },
          kv('Today', s.todayPct === null ? 'not logged' : `${pc(s.todayPct)} · ${s.todayDone}/${s.total}`),
          kv('7 days', `${pc(s.d7)} ${trendMark(s.d7, s.p7)}`),
          kv('30 days', `${pc(s.d30)} ${trendMark(s.d30, s.p30)}`),
          kv('Logged', `${s.logged30}/30 days`),
          kv('Streak', plural(s.streak, 'day')))));
  }));

  const ins = [];
  const lead = ranked.find(r => val(r) !== null);
  if (lead) ins.push(['🏆', `${lead.name} leads ${rangeName} with ${pc(val(lead))}.`]);
  const spread = ranked.filter(r => val(r) !== null);
  if (spread.length >= 2) ins.push(['🔑', `Gap between first and last: ${((val(spread[0]) - val(spread[spread.length - 1])) * 100).toFixed(0)} pts (${spread[0].name} vs ${spread[spread.length - 1].name}).`]);
  const diffs = G.rows.filter(r => r.st.d7 !== null && r.st.p7 !== null).map(r => ({ r, d: r.st.d7 - r.st.p7 }));
  const up = [...diffs].sort((a, b) => b.d - a.d)[0], down = [...diffs].sort((a, b) => a.d - b.d)[0];
  if (up && up.d >= 0.05) ins.push(['📈', `Most improved this week: ${up.r.name} (+${(up.d * 100).toFixed(0)} pts vs last week).`]);
  if (down && down.d <= -0.05) ins.push(['📉', `Slipping this week: ${down.r.name} (${(down.d * 100).toFixed(0)} pts vs last week).`]);
  const t = todayKey();
  G.rows.filter(r => !r.st.lastLogged || diffDays(r.st.lastLogged, t) >= 3).forEach(r =>
    ins.push(['💤', r.st.lastLogged ? `${r.name} has not logged since ${fmt(r.st.lastLogged)}. Maybe a nudge?` : `${r.name} has not logged anything yet.`]));
  const streaker = [...G.rows].sort((a, b) => b.st.streak - a.st.streak)[0];
  if (streaker && streaker.st.streak >= 3) ins.push(['🔁', `Longest logging streak: ${streaker.name}, ${plural(streaker.st.streak, 'day')} in a row.`]);
  const loggers = [...G.rows].sort((a, b) => b.st.logged30 - a.st.logged30)[0];
  if (loggers) ins.push(['✅', `Most consistent logger (30 days): ${loggers.name}, ${loggers.st.logged30}/30 days.`]);

  fill(box, groupHead('Everyone', `${G.year} · ${people(G.rows.length)}${G.failed.length ? ` · ${G.failed.length} failed to load` : ''}`, seg), cards);

  const g = h('div', { class: 'grid-2' });
  const c1 = gcard('Daily completion, last 30 days', 'Share of Daily Dos and Habits ticked each day. Gaps are unlogged days.');
  groupChart(c1, 'line', last30Labels(), G.rows.map(r => ({ label: r.name, data: pctSeries(r.st.series), borderColor: r.color, backgroundColor: r.color, borderWidth: 2, pointRadius: 1.5, tension: .3, spanGaps: true })), { options: { scales: pctAxis } });
  const c2 = gcard('Which days work best', 'Average completion by weekday over the last 60 days.');
  groupChart(c2, 'bar', DOW, G.rows.map(r => ({ label: r.name, data: pctSeries(r.st.dowAvg), backgroundColor: r.color, borderRadius: 4 })), { options: { scales: { y: { min: 0, max: 100, ticks: { callback: v => v + '%' } }, x: { grid: { display: false } } } } });
  g.append(c1, c2);
  box.append(g);

  box.append(gcard('Side by side', 'Completion only. ▲ ▼ compare with the previous period.', table(
    ['Person', 'Today', '7 days', '30 days', 'Logged (30d)', 'Streak'],
    ranked.map(r => { const s = r.st; return [
      h('span', null, dot(r.color), r.name), s.todayPct === null ? '—' : pc(s.todayPct), `${pc(s.d7)} ${trendMark(s.d7, s.p7)}`, `${pc(s.d30)} ${trendMark(s.d30, s.p30)}`,
      `${s.logged30}/30`, plural(s.streak, 'day')
    ]; }))));
  box.append(gcard('What stands out', rangeName, ins.length ? insightList(ins) : h('p', { class: 'muted' }, 'Not enough logged days yet.')));
}

/* =========================================================
 * INSIGHTS — the group as a whole
 * ======================================================= */
function groupInsights(box, G) {
  const rows = G.rows, t = todayKey();
  const all = (k) => rows.map(r => r.st[k]).filter(v => v !== null && v !== undefined);
  const g30 = all('d30'), g7 = all('d7'), p7 = all('p7');
  const active = rows.filter(r => r.st.todayPct !== null).length;
  const groupSeries = last30Labels().map((_, i) => { const v = rows.map(r => r.st.series[i]).filter(x => x !== null); return v.length ? mean(v) : null; });
  const groupDow = DOW.map((_, w) => { const v = rows.map(r => r.st.dowAvg[w]).filter(x => x !== null); return v.length ? mean(v) : null; });

  fill(box, groupHead('Combined insights', `${G.year} · ${people(rows.length)} together · completion only`));
  box.append(h('div', { class: 'tiles' },
    tile('People tracked', rows.length, `${active} logged today`),
    tile('Group completion (30d)', pc(g30.length ? mean(g30) : null), g7.length && p7.length ? `${trendMark(mean(g7), mean(p7))} ${pc(mean(g7))} this week vs ${pc(mean(p7))} before` : null),
    tile('Longest streak', plural(Math.max(0, ...rows.map(r => r.st.streak)), 'day'), rows.slice().sort((a, b) => b.st.streak - a.st.streak)[0]?.name)));

  const g = h('div', { class: 'grid-2' });
  const c1 = gcard('Group completion, last 30 days', 'Thick line is the average of everyone; thin lines are each person.');
  groupChart(c1, 'line', last30Labels(), [
    ...rows.map(r => ({ label: r.name, data: pctSeries(r.st.series), borderColor: r.color + '88', backgroundColor: r.color, borderWidth: 1, pointRadius: 0, tension: .3, spanGaps: true })),
    { label: 'Everyone', data: pctSeries(groupSeries), borderColor: css('--ink'), backgroundColor: css('--ink'), borderWidth: 3, pointRadius: 0, tension: .3, spanGaps: true }], { options: { scales: pctAxis } });
  const c2 = gcard('Best days for the group', 'Average completion by weekday, last 60 days.');
  groupChart(c2, 'bar', DOW, [{ label: 'Everyone', data: pctSeries(groupDow), backgroundColor: css('--accent'), borderRadius: 6 }], { options: { plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 100, ticks: { callback: v => v + '%' } }, x: { grid: { display: false } } } } });
  g.append(c1, c2);
  box.append(g);

  const ins = [];
  if (g7.length && p7.length) { const d = mean(g7) - mean(p7); ins.push([d >= 0 ? '📈' : '📉', `The group is ${Math.abs(d) < 0.02 ? 'steady' : d > 0 ? 'up' : 'down'} this week: ${pc(mean(g7))} vs ${pc(mean(p7))} the week before.`]); }
  const bestDay = DOW.map((d, i) => ({ d, v: groupDow[i] })).filter(x => x.v !== null).sort((a, b) => b.v - a.v);
  if (bestDay.length > 1) ins.push(['📅', `Everyone does best on ${bestDay[0].d} (${pc(bestDay[0].v)}) and worst on ${bestDay[bestDay.length - 1].d} (${pc(bestDay[bestDay.length - 1].v)}).`]);
  const quiet = rows.filter(r => !r.st.lastLogged || diffDays(r.st.lastLogged, t) >= 3).map(r => r.name);
  if (quiet.length) ins.push(['💤', `Not logging lately: ${quiet.join(', ')}.`]);
  box.append(gcard('What stands out', null, insightList(ins)));
}
