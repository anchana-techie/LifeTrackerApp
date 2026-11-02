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

    const win30 = [addDays(t, -29) < ix.first ? ix.first : addDays(t, -29), t];
    const items = kinds.flatMap(k => (analyzeGrid(k, win30)?.items || []).map(i => ({ ...i, kind: k })));
    const rated = items.filter(i => i.rate !== null);
    const best = [...rated].sort((a, b) => b.rate - a.rate)[0] || null;
    const weak = [...rated].sort((a, b) => a.rate - b.rate)[0] || null;
    const topStreak = [...items].sort((a, b) => b.current - a.current)[0] || null;

    const lastLogged = [...logged].filter(d => d <= t).sort().pop() || null;
    const dowAvg = Array.from({ length: 7 }, (_, w) => {
      const v = rangeDays(addDays(t, -59), t).filter(d => logged.has(d) && dow(d) === w).map(pctOn);
      return v.length ? mean(v) : null;
    });

    const prof = S.data.profile, wdays = S.data.water.days;
    const wv = rangeDays(addDays(t, -6), t).map(d => { const x = wdays[d], goal = prof.waterGoal || x?.goal; return x && goal ? x.total / goal : null; }).filter(v => v !== null);

    const Wall = analyzeWeight([ix.first, t]), W30 = analyzeWeight(win30);
    const weight = Wall && Wall.n ? {
      latest: Wall.latest[1], date: Wall.latest[0],
      delta30: W30 && W30.n > 1 ? W30.latest[1] - W30.first[1] : null,
      bmi: prof.height ? bmiInfo(Wall.latest[1], prof.height) : null
    } : null;

    return {
      total, lastLogged,
      todayPct: logged.has(t) ? pctOn(t) : null, todayDone: logged.has(t) ? doneOn(t) : null,
      d7: avgOver(addDays(t, -6), t), p7: avgOver(addDays(t, -13), addDays(t, -7)),
      d30: avgOver(addDays(t, -29), t), p30: avgOver(addDays(t, -59), addDays(t, -30)),
      logged30: w30.filter(d => logged.has(d)).length,
      streak: streakEnding(logged, logged.has(t) ? t : addDays(t, -1)),
      series: w30.map(d => logged.has(d) ? pctOn(d) : null),
      dowAvg, items, best, weak, topStreak,
      water7: wv.length ? mean(wv) : null, waterDays: wv.length, waterGoalDays: wv.filter(v => v >= 1).length,
      weight, goalMl: prof.waterGoal,
      spend: analyzeSpending().months.map(m => ({ m: m.m, planned: m.planned, spent: m.boughtVal, budget: m.budget, bought: m.boughtCount, count: m.items.length }))
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
  ({ log: groupToday, buy: groupBuy, analysis: groupInsights })[tab](box, G);
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
          kv('Streak', plural(s.streak, 'day')))),
      h('div', { class: 'pc-foot' },
        s.best ? h('span', { class: 'pill teal' }, icon('thumb-up'), `${s.best.name} ${pc(s.best.rate)}`) : null,
        s.weak && s.weak !== s.best ? h('span', { class: 'pill warn' }, icon('alert-triangle'), `${s.weak.name} ${pc(s.weak.rate)}`) : null));
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
  const wet = G.rows.filter(r => r.st.water7 !== null).sort((a, b) => b.st.water7 - a.st.water7)[0];
  if (wet) ins.push(['✨', `Best hydrated this week: ${wet.name} (${pc(wet.st.water7)} of goal on average).`]);

  fill(box, groupHead('Everyone', `${G.year} · ${people(G.rows.length)}${G.failed.length ? ` · ${G.failed.length} failed to load` : ''}`, seg), cards);

  const g = h('div', { class: 'grid-2' });
  const c1 = gcard('Daily completion, last 30 days', 'Share of Daily Dos and Habits ticked each day. Gaps are unlogged days.');
  groupChart(c1, 'line', last30Labels(), G.rows.map(r => ({ label: r.name, data: pctSeries(r.st.series), borderColor: r.color, backgroundColor: r.color, borderWidth: 2, pointRadius: 1.5, tension: .3, spanGaps: true })), { options: { scales: pctAxis } });
  const c2 = gcard('Which days work best', 'Average completion by weekday over the last 60 days.');
  groupChart(c2, 'bar', DOW, G.rows.map(r => ({ label: r.name, data: pctSeries(r.st.dowAvg), backgroundColor: r.color, borderRadius: 4 })), { options: { scales: { y: { min: 0, max: 100, ticks: { callback: v => v + '%' } }, x: { grid: { display: false } } } } });
  g.append(c1, c2);
  box.append(g);

  box.append(gcard('Side by side', 'Everything in one table. ▲ ▼ compare with the previous period.', table(
    ['Person', 'Today', '7 days', '30 days', 'Logged (30d)', 'Streak', 'Strongest', 'Needs work', 'Water (7d)', 'Weight', 'BMI'],
    ranked.map(r => { const s = r.st; return [
      h('span', null, dot(r.color), r.name), s.todayPct === null ? '—' : pc(s.todayPct), `${pc(s.d7)} ${trendMark(s.d7, s.p7)}`, `${pc(s.d30)} ${trendMark(s.d30, s.p30)}`,
      `${s.logged30}/30`, plural(s.streak, 'day'), s.best ? `${s.best.name} (${pc(s.best.rate)})` : '—', s.weak ? `${s.weak.name} (${pc(s.weak.rate)})` : '—',
      s.water7 === null ? '—' : pc(s.water7), s.weight ? `${s.weight.latest} kg${s.weight.delta30 === null ? '' : ` (${s.weight.delta30 >= 0 ? '+' : ''}${s.weight.delta30.toFixed(1)})`}` : '—',
      s.weight?.bmi ? h('span', { class: 'tag ' + (s.weight.bmi.cls === 'good' ? 'good' : 'bad') }, `${s.weight.bmi.bmi.toFixed(1)} ${s.weight.bmi.label}`) : '—'
    ]; }))));
  box.append(gcard('What stands out', rangeName, ins.length ? insightList(ins) : h('p', { class: 'muted' }, 'Not enough logged days yet.')));
}

/* =========================================================
 * BUY LIST — spending compared by month
 * ======================================================= */
function groupBuy(box, G) {
  const monthsAll = MONTHS.map((m, i) => ({ m, i, any: G.rows.some(r => { const x = r.st.spend[i]; return x.planned || x.spent || x.budget; }) }));
  if (!S.gMonths) S.gMonths = new Set(monthsAll.filter(x => x.any).map(x => x.m));
  const sel = MONTHS.filter(m => S.gMonths.has(m));
  const toggle = m => { S.gMonths.has(m) ? S.gMonths.delete(m) : S.gMonths.add(m); renderGroupTab('buy'); };
  const chips = h('div', { class: 'month-chips', style: 'margin-bottom:16px' },
    h('button', { class: 'chip', 'aria-pressed': String(sel.length === 12), onclick: () => { S.gMonths = new Set(sel.length === 12 ? [] : MONTHS); renderGroupTab('buy'); } }, 'All'),
    MONTHS.map(m => h('button', { class: 'chip', 'aria-pressed': String(S.gMonths.has(m)), onclick: () => toggle(m) }, m.slice(0, 3))));

  const sum = r => {
    const rows = sel.map(m => r.st.spend[MONTHS.indexOf(m)]);
    const add = k => rows.reduce((s, x) => s + (x[k] || 0), 0);
    const budgetMonths = rows.filter(x => x.budget);
    return { planned: add('planned'), spent: add('spent'), bought: add('bought'), count: add('count'),
      budget: budgetMonths.reduce((s, x) => s + x.budget, 0), budgetSpent: budgetMonths.reduce((s, x) => s + x.spent, 0) };
  };
  const tot = G.rows.map(r => ({ r, ...sum(r) }));
  const grand = tot.reduce((s, x) => ({ planned: s.planned + x.planned, spent: s.spent + x.spent, budget: s.budget + x.budget, bought: s.bought + x.bought, count: s.count + x.count }), { planned: 0, spent: 0, budget: 0, bought: 0, count: 0 });

  fill(box, groupHead('Spending', `${G.year} · ${sel.length ? sel.length === 12 ? 'all months' : sel.map(m => m.slice(0, 3)).join(', ') : 'no month selected'}`), chips);
  if (!sel.length) { box.append(h('p', { class: 'empty' }, 'Pick one or more months above.')); return; }

  box.append(h('div', { class: 'tiles' },
    tile('Spent (planned items bought)', rupee(grand.spent), `${grand.bought} of ${grand.count} planned items bought`),
    tile('Planned', rupee(grand.planned), `${rupee(grand.planned - grand.spent)} not bought yet`),
    tile('Budgets set', rupee(grand.budget), grand.budget ? `${pc(grand.budget ? tot.reduce((s, x) => s + x.budgetSpent, 0) / grand.budget : null)} used` : 'No budgets in these months'),
    tile('Average per person', rupee(grand.spent / G.rows.length), `across ${people(G.rows.length)}`)));

  const g = h('div', { class: 'grid-2' });
  const c1 = gcard('Spent per month', 'Cost of planned items marked as bought.');
  groupChart(c1, 'bar', sel.map(m => m.slice(0, 3)), G.rows.map(r => ({ label: r.name, data: sel.map(m => r.st.spend[MONTHS.indexOf(m)].spent), backgroundColor: r.color, borderRadius: 4 })),
    { options: { scales: { y: { ticks: { callback: v => '₹' + v.toLocaleString('en-IN') } }, x: { grid: { display: false } } } } });
  const c2 = gcard('Planned vs spent', 'Per person, for the selected months.');
  groupChart(c2, 'bar', G.rows.map(r => r.name), [
    { label: 'Planned', data: tot.map(x => x.planned), backgroundColor: css('--ink-3'), borderRadius: 4 },
    { label: 'Spent', data: tot.map(x => x.spent), backgroundColor: css('--accent'), borderRadius: 4 },
    { label: 'Budget', data: tot.map(x => x.budget || null), backgroundColor: css('--water'), borderRadius: 4 }],
    { options: { scales: { y: { ticks: { callback: v => '₹' + v.toLocaleString('en-IN') } }, x: { grid: { display: false } } } } });
  g.append(c1, c2);
  box.append(g);

  box.append(gcard('Person by person', null, table(['Person', 'Planned', 'Spent', 'Budget', 'Left / over', 'Items bought', 'Share of group spend'],
    tot.map(x => [h('span', null, dot(x.r.color), x.r.name), rupee(x.planned), rupee(x.spent), x.budget ? rupee(x.budget) : '—',
      x.budget ? h('span', { class: 'tag ' + (x.budgetSpent > x.budget ? 'bad' : 'good') }, x.budgetSpent > x.budget ? `over by ${rupee(x.budgetSpent - x.budget)}` : `${rupee(x.budget - x.budgetSpent)} left`) : '—',
      `${x.bought}/${x.count}`, grand.spent ? pc(x.spent / grand.spent) : '—']))));

  box.append(gcard('Month by month', 'Spent, with planned in brackets.', table(['Month', ...G.rows.map(r => r.name), 'Everyone'],
    sel.map(m => { const i = MONTHS.indexOf(m), cells = G.rows.map(r => r.st.spend[i]);
      return [m, ...cells.map(c => c.planned || c.spent ? `${rupee(c.spent)} (${rupee(c.planned)})` : '—'), `${rupee(cells.reduce((s, c) => s + c.spent, 0))} (${rupee(cells.reduce((s, c) => s + c.planned, 0))})`]; }))));

  const ins = [];
  const top = [...tot].sort((a, b) => b.spent - a.spent)[0];
  if (top && top.spent) ins.push(['💸', `${top.r.name} spent the most: ${rupee(top.spent)} (${pc(top.spent / grand.spent)} of the group).`]);
  tot.filter(x => x.budget && x.budgetSpent > x.budget).forEach(x => ins.push(['🔴', `${x.r.name} is over budget by ${rupee(x.budgetSpent - x.budget)} in these months.`]));
  tot.filter(x => x.budget && x.budgetSpent / x.budget >= .85 && x.budgetSpent <= x.budget).forEach(x => ins.push(['🟡', `${x.r.name} has used ${pc(x.budgetSpent / x.budget)} of the budget.`]));
  const pm = sel.map(m => ({ m, v: G.rows.reduce((s, r) => s + r.st.spend[MONTHS.indexOf(m)].spent, 0) })).sort((a, b) => b.v - a.v)[0];
  if (pm && pm.v) ins.push(['📅', `Busiest month for the group: ${pm.m} (${rupee(pm.v)}).`]);
  const gap = [...tot].sort((a, b) => (b.planned - b.spent) - (a.planned - a.spent))[0];
  if (gap && gap.planned - gap.spent > 0) ins.push(['🛒', `${gap.r.name} has the most planned but not yet bought: ${rupee(gap.planned - gap.spent)}.`]);
  box.append(gcard('What stands out', null, ins.length ? insightList(ins) : h('p', { class: 'muted' }, 'No spending in these months yet.')));
}

/* =========================================================
 * INSIGHTS — the group as a whole
 * ======================================================= */
function groupInsights(box, G) {
  const rows = G.rows, t = todayKey();
  const all = (k) => rows.map(r => r.st[k]).filter(v => v !== null && v !== undefined);
  const g30 = all('d30'), g7 = all('d7'), p7 = all('p7');
  const active = rows.filter(r => r.st.todayPct !== null).length;
  const water = all('water7');
  const spent = rows.reduce((s, r) => s + r.st.spend.reduce((a, x) => a + x.spent, 0), 0);
  const groupSeries = last30Labels().map((_, i) => { const v = rows.map(r => r.st.series[i]).filter(x => x !== null); return v.length ? mean(v) : null; });
  const groupDow = DOW.map((_, w) => { const v = rows.map(r => r.st.dowAvg[w]).filter(x => x !== null); return v.length ? mean(v) : null; });

  fill(box, groupHead('Combined insights', `${G.year} · ${people(rows.length)} together`));
  box.append(h('div', { class: 'tiles' },
    tile('People tracked', rows.length, `${active} logged today`),
    tile('Group completion (30d)', pc(g30.length ? mean(g30) : null), g7.length && p7.length ? `${trendMark(mean(g7), mean(p7))} ${pc(mean(g7))} this week vs ${pc(mean(p7))} before` : null),
    tile('Hydration (7d)', water.length ? pc(mean(water)) : '—', water.length ? `average of daily goal · ${plural(rows.reduce((s, r) => s + r.st.waterGoalDays, 0), 'goal day')}` : 'No water logged yet'),
    tile('Total spent', rupee(spent), 'planned items bought, whole year'),
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

  // items: shared ones compared across people, plus the group's best and weakest
  const flat = rows.flatMap(r => r.st.items.filter(i => i.rate !== null).map(i => ({ ...i, who: r.name, key: norm(i.name) })));
  const byName = {};
  flat.forEach(i => (byName[i.key] ||= []).push(i));
  const shared = Object.values(byName).filter(a => a.length >= 2).map(a => ({ name: a[0].name, n: a.length, avg: mean(a.map(x => x.rate)), hi: [...a].sort((x, y) => y.rate - x.rate)[0], lo: [...a].sort((x, y) => x.rate - y.rate)[0] })).sort((a, b) => b.avg - a.avg);
  const sorted = [...flat].sort((a, b) => b.rate - a.rate);
  const g2 = h('div', { class: 'grid-2' });
  g2.append(gcard('Going well', 'Highest completion over the last 30 days.', table(['Item', 'Person', 'Rate'], sorted.slice(0, 6).map(i => [i.name, h('span', null, dot(rows.find(r => r.name === i.who).color), i.who), pc(i.rate)]))));
  g2.append(gcard('Needs attention', 'Lowest completion over the last 30 days.', table(['Item', 'Person', 'Rate'], sorted.slice(-6).reverse().map(i => [i.name, h('span', null, dot(rows.find(r => r.name === i.who).color), i.who), pc(i.rate)]))));
  box.append(g2);
  if (shared.length) box.append(gcard('Items several people track', 'The same task compared across people (last 30 days).', table(['Item', 'People', 'Average', 'Best', 'Lowest'],
    shared.slice(0, 10).map(s => [s.name, s.n, pc(s.avg), `${s.hi.who} ${pc(s.hi.rate)}`, `${s.lo.who} ${pc(s.lo.rate)}`]))));

  const g3 = h('div', { class: 'grid-2' });
  const c3 = gcard('Hydration', 'Average share of the daily water goal, last 7 days.');
  groupChart(c3, 'bar', rows.map(r => r.name), [{ label: 'Of goal', data: rows.map(r => r.st.water7 === null ? null : +(r.st.water7 * 100).toFixed(0)), backgroundColor: css('--water'), borderRadius: 6 }],
    { options: { plugins: { legend: { display: false } }, scales: { y: { min: 0, suggestedMax: 100, ticks: { callback: v => v + '%' } }, x: { grid: { display: false } } } } });
  const c4 = gcard('Body', 'Latest weight, 30-day change and BMI.', table(['Person', 'Weight', '30 days', 'BMI'], rows.map(r => { const w = r.st.weight; return [
    h('span', null, dot(r.color), r.name), w ? `${w.latest} kg` : '—', w && w.delta30 !== null ? `${w.delta30 >= 0 ? '+' : ''}${w.delta30.toFixed(1)} kg` : '—',
    w?.bmi ? h('span', { class: 'tag ' + (w.bmi.cls === 'good' ? 'good' : 'bad') }, `${w.bmi.bmi.toFixed(1)} ${w.bmi.label}`) : 'no height set']; })));
  g3.append(c3, c4);
  box.append(g3);

  const ins = [];
  if (g7.length && p7.length) { const d = mean(g7) - mean(p7); ins.push([d >= 0 ? '📈' : '📉', `The group is ${Math.abs(d) < 0.02 ? 'steady' : d > 0 ? 'up' : 'down'} this week: ${pc(mean(g7))} vs ${pc(mean(p7))} the week before.`]); }
  const bestDay = DOW.map((d, i) => ({ d, v: groupDow[i] })).filter(x => x.v !== null).sort((a, b) => b.v - a.v);
  if (bestDay.length > 1) ins.push(['📅', `Everyone does best on ${bestDay[0].d} (${pc(bestDay[0].v)}) and worst on ${bestDay[bestDay.length - 1].d} (${pc(bestDay[bestDay.length - 1].v)}).`]);
  if (sorted[0]) ins.push(['🏆', `Strongest habit anywhere: ${sorted[0].who}'s “${sorted[0].name}” at ${pc(sorted[0].rate)}.`]);
  if (sorted.length > 1) ins.push(['⚠️', `Weakest: ${sorted[sorted.length - 1].who}'s “${sorted[sorted.length - 1].name}” at ${pc(sorted[sorted.length - 1].rate)}.`]);
  if (shared[0] && shared.length > 1) ins.push(['🔑', `Most shared item that works: “${shared[0].name}” (${pc(shared[0].avg)} across ${shared[0].n} people).`]);
  const off = rows.filter(r => r.st.weight?.bmi && r.st.weight.bmi.cls !== 'good');
  if (off.length) ins.push(['⚖️', `Outside the healthy BMI range: ${off.map(r => `${r.name} (${r.st.weight.bmi.label.toLowerCase()})`).join(', ')}.`]);
  const noWater = rows.filter(r => r.st.water7 === null).map(r => r.name);
  if (noWater.length) ins.push(['ℹ️', `No water logged in the last 7 days: ${noWater.join(', ')}.`]);
  const quiet = rows.filter(r => !r.st.lastLogged || diffDays(r.st.lastLogged, t) >= 3).map(r => r.name);
  if (quiet.length) ins.push(['💤', `Not logging lately: ${quiet.join(', ')}.`]);
  box.append(gcard('What stands out', null, insightList(ins)));
}
