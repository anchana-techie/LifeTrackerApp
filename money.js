/* Money: balance, income, spending and savings from a starting balance onwards.
 * - Start: the balance on the day tracking began (one per year file). Nothing earlier is needed.
 * - Income, Spend, Saving entries are added by hand (salary is logged when it arrives; it can change every month).
 * - Buy list items marked bought count as spending automatically, or as savings if switched (FD, gold…).
 * - Monthly bills / SIPs: fixed ones count on their day automatically; variable ones ask for the amount when due.
 *   An entry tied to a bill replaces that month's automatic amount (0 = skipped).
 * - Check balance: the gap between the real bank balance and the app's is saved as an Adjust entry.
 * Rows live in the year file: Money, Money Bills, Money Settings. */
'use strict';

const Money = (() => {
  const CATS = {
    Spend: [['Food', 'tools-kitchen-2'], ['Groceries', 'basket'], ['Travel', 'car'], ['Bills', 'receipt'], ['Rent', 'home'], ['Shopping', 'shopping-bag'],
      ['Health', 'heart-plus'], ['Fun', 'confetti'], ['Family', 'users'], ['Gifts', 'gift'], ['Other', 'dots']],
    Income: [['Salary', 'briefcase'], ['Freelance', 'device-laptop'], ['Bonus', 'sparkles'], ['Refund', 'receipt-refund'], ['Gift', 'gift'], ['Other', 'dots']],
    Saving: [['FD', 'building-bank'], ['SIP', 'chart-line'], ['RD', 'pig-money'], ['Gold', 'diamond'], ['Emergency fund', 'shield-check'], ['Other', 'pig-money']]
  };
  const ICON = Object.fromEntries(Object.values(CATS).flat());
  const TYPE_LABEL = { Spend: 'Spend', Income: 'Income', Saving: 'Saving' };
  const M = { month: null, form: null, check: false, billForm: null, billsOpen: false };

  const rid = () => { const a = new Uint8Array(8); crypto.getRandomValues(a); return [...a].map(b => (b % 36).toString(36)).join('') + Date.now().toString(36).slice(-4); };
  const data = () => (S.data.money ||= { entries: [], bills: [], savingsItems: [] });
  const startEntry = () => data().entries.find(e => e.type === 'Start') || null;
  const ymOf = d => d.slice(0, 7);
  const monthName = ym => MONTHS[Number(ym.slice(5, 7)) - 1];
  const ymLabel = ym => `${monthName(ym)} ${ym.slice(0, 4)}`;
  const lastDay = ym => { const [y, m] = ym.split('-').map(Number); return `${ym}-${pad(new Date(y, m, 0).getDate())}`; };
  const addMonth = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
  const isSavingItem = name => data().savingsItems.some(x => norm(x) === norm(name));
  /** ₹ with paise only when there are any: ₹1,500 / ₹62.84 */
  const rs = n => { const v = Math.round(Math.abs(Number(n)) * 100) / 100; return '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }); };
  const money = n => (Math.round(n * 100) < 0 ? '−' : '') + rs(n);
  const r2 = n => Math.round(n * 100) / 100;

  /* ---------- the ledger ---------- */
  /** Every money event in [from, to] (dates), from the start date on. kind: income | spend | saving | adjust | due | upcoming */
  function events(from, to) {
    const st = startEntry();
    if (!st) return [];
    const lo = from < st.date ? st.date : from, t = todayKey(), out = [];
    const d = data();
    for (const e of d.entries) {
      if (e.type === 'Start' || e.date < lo || e.date > to) continue;
      const kind = e.type === 'Income' ? 'income' : e.type === 'Saving' ? 'saving' : e.type === 'Adjust' ? 'adjust' : 'spend';
      out.push({ src: 'entry', id: e.id, date: e.date, kind, category: e.category || (kind === 'adjust' ? 'Untracked' : 'Other'), label: e.note || e.category || TYPE_LABEL[e.type] || 'Adjustment', amount: e.amount, bill: e.bill, entry: e });
    }
    // Buy list purchases
    const months = S.data.sheets.buy?.months || {};
    for (const mName of Object.keys(months)) {
      for (const it of months[mName] || []) {
        const bd = boughtInMonth(it.product, mName);
        if (!bd || bd < lo || bd > to || !(Number(it.cost) > 0)) continue;
        const sav = isSavingItem(it.product);
        out.push({ src: 'buy', id: 'buy:' + mName + ':' + it.product, date: bd, kind: sav ? 'saving' : 'spend', category: sav ? 'Savings (Buy list)' : 'Buy list', label: it.product, amount: Number(it.cost), product: it.product });
      }
    }
    // monthly bills and SIPs
    for (let ym = ymOf(lo); ym <= ymOf(to); ym = addMonth(ym, 1)) {
      for (const b of d.bills) {
        if (b.from && ym < b.from) continue;
        if (b.until && ym > b.until) continue;
        const date = `${ym}-${pad(b.day)}`;
        if (date < lo || date > to) continue;
        if (d.entries.some(e => e.bill === b.id && ymOf(e.date) === ym)) continue;   // this month's amount was entered
        const kind = b.kind === 'Saving' ? 'saving' : 'spend';
        if (date > t) out.push({ src: 'bill', id: 'bill:' + b.id + ':' + ym, date, kind: 'upcoming', realKind: kind, category: b.category, label: b.name, amount: b.variable ? null : b.amount, billObj: b, ym });
        else if (b.variable) out.push({ src: 'bill', id: 'bill:' + b.id + ':' + ym, date, kind: 'due', realKind: kind, category: b.category, label: b.name, amount: null, billObj: b, ym });
        else out.push({ src: 'bill', id: 'bill:' + b.id + ':' + ym, date, kind, category: b.category, label: b.name, amount: b.amount, billObj: b, ym });
      }
    }
    return out.sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
  }
  const counted = e => ['income', 'spend', 'saving', 'adjust'].includes(e.kind);
  function totals(list) {
    const t = { income: 0, spend: 0, saving: 0, adjust: 0, byCat: {} };
    for (const e of list) {
      if (!counted(e)) continue;
      t[e.kind] += e.amount;
      if (e.kind === 'spend') t.byCat[e.category] = (t.byCat[e.category] || 0) + e.amount;
    }
    if (t.adjust < 0) t.byCat['Untracked'] = (t.byCat['Untracked'] || 0) - t.adjust;
    return t;
  }
  /** Balance on a date: start + income + adjustments - spending - savings. */
  function balance(asOf = todayKey()) {
    const st = startEntry();
    if (!st) return null;
    const t = totals(events(st.date, asOf));
    return st.amount + t.income + t.adjust - t.spend - t.saving;
  }

  /* ---------- local updates (from app.js applyLocal) ---------- */
  function applyLocal(action, p) {
    const d = data();
    if (action === 'saveMoney') {
      const e = { id: p.id, date: p.date, type: p.type, category: p.category || '', note: p.note || '', amount: Number(p.amount), bill: p.bill || '' };
      const i = d.entries.findIndex(x => x.id === p.id);
      if (i >= 0) d.entries[i] = e; else d.entries.push(e);
    } else if (action === 'deleteMoney') d.entries = d.entries.filter(x => x.id !== p.id);
    else if (action === 'saveBill') {
      const b = { id: p.id, name: p.name, amount: p.amount === '' ? 0 : Number(p.amount), day: Number(p.day), category: p.category || 'Bills', kind: p.kind, variable: !!p.variable, from: p.from, until: p.until || '' };
      const i = d.bills.findIndex(x => x.id === p.id);
      if (i >= 0) d.bills[i] = b; else d.bills.push(b);
    } else if (action === 'deleteBill') d.bills = d.bills.filter(x => x.id !== p.id);
    else if (action === 'setSavingsItems') d.savingsItems = p.items.slice();
  }

  /* ---------- pieces ---------- */
  const catIcon = (c, kind) => ICON[c] || (kind === 'income' ? 'arrow-down-left' : kind === 'saving' ? 'pig-money' : c === 'Buy list' ? 'shopping-cart' : c === 'Untracked' ? 'help-circle' : 'receipt');

  function setupCard() {
    const amt = h('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', placeholder: 'e.g. 15000', class: 'mn-big-input', 'aria-label': 'Balance today' });
    const date = h('input', { type: 'date', value: clampDate(todayKey()), min: S.idx.first, max: S.idx.last, 'aria-label': 'Starting date' });
    return h('form', { class: 'card mn-setup', onsubmit: e => {
      e.preventDefault();
      const v = Number(amt.value);
      if (amt.value === '' || !(v >= 0)) return toast('Enter your balance today (0 is fine).', true);
      sendQuick('saveMoney', { id: rid(), date: date.value || clampDate(todayKey()), type: 'Start', category: '', note: 'Starting balance', amount: v || 0.01 });
      toast('Tracking starts now 🎉');
      M.month = ymOf(date.value || todayKey());
      render();
    } },
      h('div', { class: 'mn-setup-ico' }, icon('wallet')),
      h('h2', null, 'Start fresh from today'),
      h('p', { class: 'sub' }, 'No need to remember the past. Enter what you have right now, then keep going from here.'),
      h('ol', { class: 'mn-steps' },
        h('li', null, h('b', null, 'Your balance today'), ' (bank + cash) is the starting point.'),
        h('li', null, h('b', null, 'Add income'), ' when it arrives: salary can be different every month.'),
        h('li', null, h('b', null, 'Spending'), ' from the Buy list counts automatically; add other spends in a tap.'),
        h('li', null, h('b', null, 'Check balance'), ' now and then: any gap is saved as untracked, so it stays right.')),
      h('label', null, 'Balance today (₹)', amt),
      h('label', null, 'Starting from', date),
      h('div', { class: 'row-actions' }, h('span', { class: 'spacer' }), h('button', { class: 'btn primary', type: 'submit' }, icon('player-play'), ' Start tracking')));
  }

  function hero() {
    const st = startEntry(), bal = balance(), ro = S.readOnly;
    const num = h('span', { class: 'mn-balance-num' + (bal < 0 ? ' neg' : '') });
    countUp(num, r2(bal), money, 'mn-balance');
    return h('div', { class: 'card mn-hero' },
      h('div', { class: 'mn-hero-top' },
        h('div', null, h('p', { class: 'mn-cap' }, 'Balance now'), num, h('p', { class: 'sub' }, `Tracking since ${fmt(st.date)} · started with ${money(st.amount)}`)),
        ro ? null : h('button', { class: 'btn small ghost', type: 'button', onclick: () => { M.check = !M.check; M.form = null; render(); } }, icon('scale'), ' Check balance')),
      ro ? null : h('div', { class: 'mn-actions' },
        actionBtn('Spend', 'minus', 'spend'), actionBtn('Income', 'plus', 'income'), actionBtn('Saving', 'pig-money', 'saving')),
      M.check ? checkPanel(bal) : null,
      M.form ? entryForm() : null);
  }
  const actionBtn = (type, ic, cls) => h('button', { class: 'mn-act ' + cls + (M.form?.type === type && !M.form.id ? ' on' : ''), type: 'button', onclick: () => {
    M.check = false;
    M.form = M.form?.type === type && !M.form.id ? null : { type, amount: '', category: CATS[type][0][0], date: defaultDate(), note: '' };
    render();
    setTimeout(() => document.querySelector('.mn-form .mn-big-input')?.focus(), 60);
  } }, h('span', { class: 'mn-act-ico' }, icon(ic)), type === 'Spend' ? 'Add spend' : type === 'Income' ? 'Add income' : 'Add saving');

  const defaultDate = () => { const t = todayKey(); return M.month && ymOf(t) !== M.month ? (M.month < ymOf(t) ? lastDay(M.month) : `${M.month}-01`) : clampDate(t); };

  function entryForm() {
    const f = M.form, st = startEntry();
    const amt = h('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', value: f.amount, placeholder: '₹ 0', class: 'mn-big-input', 'aria-label': 'Amount' });
    amt.addEventListener('input', () => { f.amount = amt.value; });
    const date = h('input', { type: 'date', value: f.date, min: st.date, max: S.idx.last, 'aria-label': 'Date' });
    date.addEventListener('change', () => { f.date = date.value; });
    const note = h('input', { type: 'text', maxlength: '120', value: f.note, placeholder: f.type === 'Income' ? 'e.g. November salary' : 'Note (optional)', 'aria-label': 'Note' });
    note.addEventListener('input', () => { f.note = note.value; });
    const chips = h('div', { class: 'chips mn-cats', role: 'group', 'aria-label': 'Category' },
      CATS[f.type].map(([c, ic]) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(f.category === c), onclick: e => {
        f.category = c; chips.querySelectorAll('.chip').forEach(b => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
      } }, icon(ic), ' ', c)));
    const save = () => {
      const v = Number(f.amount);
      if (!(v > 0) && !(f.bill && v === 0)) return toast('Enter an amount.', true);
      if (!f.date || f.date < st.date) return toast(`Pick a date from ${fmt(st.date)} on.`, true);
      sendQuick('saveMoney', { id: f.id || rid(), date: f.date, type: f.type, category: f.category, note: f.note.trim(), amount: v, bill: f.bill || '' });
      toast(f.id ? 'Saved' : `${f.type === 'Income' ? 'Income' : f.type === 'Saving' ? 'Saving' : 'Spend'} of ${rs(v)} added`);
      M.month = ymOf(f.date); M.form = null; M.flash = true;
      render();
    };
    [amt, note].forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } }));
    return h('div', { class: 'mn-form ' + f.type.toLowerCase() },
      h('div', { class: 'mn-form-head' }, h('b', null, f.id ? `Edit ${f.type.toLowerCase()}` : f.bill ? `${f.label} · ${ymLabel(ymOf(f.date))}` : TYPE_LABEL[f.type]),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => { M.form = null; render(); } }, icon('x'))),
      amt, f.bill ? null : chips,
      h('div', { class: 'mn-form-row' }, h('label', null, 'Date', date), h('label', null, 'Note', note)),
      f.bill ? h('p', { class: 'sub' }, 'Enter 0 to skip this month.') : null,
      h('div', { class: 'row-actions' },
        f.id ? h('button', { class: 'btn small ghost danger-text', type: 'button', onclick: () => {
          if (!confirm('Delete this entry?')) return;
          sendQuick('deleteMoney', { id: f.id }); M.form = null; toast('Deleted'); render();
        } }, icon('trash'), ' Delete') : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary', type: 'button', onclick: save }, icon('check'), f.id ? ' Save' : ' Add')));
  }

  function checkPanel(bal) {
    const real = h('input', { type: 'number', step: 'any', inputmode: 'decimal', placeholder: 'Your bank + cash now', class: 'mn-big-input', 'aria-label': 'Real balance' });
    const out = h('p', { class: 'sub mn-check-out' }, `The app says ${money(bal)}.`);
    const btn = h('button', { class: 'btn primary', type: 'button', disabled: true }, icon('check'), ' Save difference');
    real.addEventListener('input', () => {
      const diff = Math.round((Number(real.value) - bal) * 100) / 100;
      btn.disabled = real.value === '' || diff === 0;
      out.textContent = real.value === '' ? `The app says ${money(bal)}.` : diff === 0 ? 'Spot on. Nothing to fix 🎯'
        : diff < 0 ? `${rs(-diff)} less than the app: it will be saved as untracked spending.` : `${rs(diff)} more than the app: it will be saved as untracked income.`;
    });
    btn.onclick = () => {
      const diff = Math.round((Number(real.value) - bal) * 100) / 100;
      if (!diff) return;
      sendQuick('saveMoney', { id: rid(), date: clampDate(todayKey()), type: 'Adjust', category: diff < 0 ? 'Untracked spending' : 'Untracked income', note: 'Balance check', amount: diff });
      M.check = false; M.flash = true; M.month = ymOf(clampDate(todayKey()));
      toast('Balance matched');
      render();
    };
    return h('div', { class: 'mn-form check' },
      h('div', { class: 'mn-form-head' }, h('b', null, 'Check balance'), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => { M.check = false; render(); } }, icon('x'))),
      h('p', { class: 'sub' }, 'Open your bank app and type what you really have (plus cash). Any gap is saved, so you never need to remember every rupee.'),
      real, out, h('div', { class: 'row-actions' }, h('span', { class: 'spacer' }), btn));
  }

  function monthBar() {
    const st = startEntry(), first = ymOf(st.date), last = ymOf(S.idx.last);
    const go = ym => { M.month = ym; M.form = null; render(); };
    return h('div', { class: 'mn-monthbar' },
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Previous month', disabled: M.month <= first, onclick: () => go(addMonth(M.month, -1)) }, icon('chevron-left')),
      h('b', null, ymLabel(M.month)),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next month', disabled: M.month >= last, onclick: () => go(addMonth(M.month, 1)) }, icon('chevron-right')));
  }

  function monthCard() {
    const list = events(`${M.month}-01`, lastDay(M.month)), t = totals(list);
    const spent = t.spend + Math.max(0, -t.adjust), income = t.income + Math.max(0, t.adjust);
    const left = income - spent - t.saving;
    const due = list.filter(e => e.kind === 'due'), upcoming = list.filter(e => e.kind === 'upcoming');
    const shown = list.filter(e => counted(e));
    const cats = Object.entries(t.byCat).sort((a, b) => b[1] - a[1]);
    const maxCat = cats[0]?.[1] || 1;
    const ro = S.readOnly;
    const tile = (label, val, cls, key) => { const n = h('b'); countUp(n, r2(val), money, key + M.month); return h('div', { class: 'mn-tile ' + cls }, h('span', null, label), n); };
    return h('div', { class: 'card mn-month' },
      monthBar(),
      h('div', { class: 'mn-tiles' }, tile('Income', income, 'in', 'i'), tile('Spent', spent, 'out', 's'), tile('Saved', t.saving, 'save', 'v'), tile('Left', left, left < 0 ? 'neg' : 'left', 'l')),
      income ? h('div', { class: 'mn-split', role: 'img', 'aria-label': `Of income: ${Math.round(spent / income * 100)}% spent, ${Math.round(t.saving / income * 100)}% saved` },
        h('i', { class: 'out', style: `flex:${Math.max(0, spent)}` }), h('i', { class: 'save', style: `flex:${Math.max(0, t.saving)}` }), h('i', { class: 'left', style: `flex:${Math.max(0, left)}` })) : h('p', { class: 'sub' }, 'No income logged this month yet. Add it when your salary arrives.'),
      due.length ? h('div', { class: 'mn-due' }, h('h3', null, icon('bell-ringing'), ' Waiting for an amount'),
        due.map(e => h('div', { class: 'mn-due-row' }, h('span', null, h('b', null, e.label), h('span', { class: 'muted' }, ` · due ${fmt(e.date)}`)),
          ro ? null : h('button', { class: 'btn small primary', type: 'button', onclick: () => { M.form = { type: e.realKind === 'saving' ? 'Saving' : 'Spend', amount: '', category: e.category, date: e.date, note: e.label, bill: e.billObj.id, label: e.label }; render(); window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' }); } }, 'Enter amount')))) : null,
      cats.length ? h('div', { class: 'mn-cats-chart' }, h('h3', null, 'Where it went'),
        cats.map(([c, v], i) => h('div', { class: 'mn-cat-row', style: `--i:${i}` },
          h('span', { class: 'mn-cat-ico' }, icon(catIcon(c, 'spend'))), h('span', { class: 'mn-cat-name' }, c),
          h('span', { class: 'mn-cat-track' }, h('i', { style: `--w:${(v / maxCat * 100).toFixed(1)}%` })), h('b', null, rs(v))))) : null,
      h('div', { class: 'mn-list-wrap' }, h('h3', null, 'Entries'),
        shown.length ? h('ul', { class: 'mn-list' + (M.flash ? ' flash' : '') }, shown.map((e, i) => entryRow(e, i))) : h('p', { class: 'sub' }, 'Nothing yet this month.')),
      upcoming.length ? h('div', { class: 'mn-upcoming' }, h('h3', null, 'Coming up'),
        upcoming.map(e => h('div', { class: 'mn-up-row' }, icon(e.realKind === 'saving' ? 'pig-money' : 'calendar-due'), h('span', null, e.label), h('span', { class: 'muted' }, fmt(e.date)), h('b', null, e.amount ? rs(e.amount) : 'varies')))) : null);
  }

  function entryRow(e, i) {
    const sign = e.kind === 'income' || (e.kind === 'adjust' && e.amount > 0) ? '+' : e.kind === 'saving' ? '' : '−';
    const cls = e.kind === 'adjust' ? (e.amount > 0 ? 'income' : 'spend') : e.kind;
    const ro = S.readOnly;
    const sub = e.src === 'buy' ? 'Buy list' : e.src === 'bill' ? (e.realKind === 'saving' || e.kind === 'saving' ? 'Monthly saving' : 'Monthly bill') : e.kind === 'adjust' ? 'Balance check' : e.category;
    let action = null;
    if (!ro && e.src === 'entry' && e.entry.type !== 'Start') action = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Edit ${e.label}`, onclick: () => {
      M.form = { id: e.id, type: e.entry.type === 'Adjust' ? 'Spend' : e.entry.type, amount: Math.abs(e.amount), category: e.category, date: e.date, note: e.entry.note, bill: e.entry.bill, label: e.label };
      if (e.entry.type === 'Adjust') return deleteAdjust(e);
      render(); window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' });
    } }, icon(e.entry.type === 'Adjust' ? 'trash' : 'pencil'));
    else if (!ro && e.src === 'buy') action = h('button', { class: 'icon-btn' + (e.kind === 'saving' ? ' on' : ''), type: 'button', title: e.kind === 'saving' ? 'Counted as savings: tap to count as spending' : 'Count as savings (FD, gold…)', 'aria-label': `Count ${e.label} as savings`, 'aria-pressed': String(e.kind === 'saving'), onclick: () => {
      const items = data().savingsItems.filter(x => norm(x) !== norm(e.product));
      if (e.kind !== 'saving') items.push(e.product);
      sendQuick('setSavingsItems', { items }); toast(e.kind === 'saving' ? `${e.label} now counts as spending` : `${e.label} now counts as savings`); render();
    } }, icon('pig-money'));
    else if (!ro && e.src === 'bill') action = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Change ${e.label} for this month`, title: 'Change or skip this month', onclick: () => {
      M.form = { type: e.kind === 'saving' ? 'Saving' : 'Spend', amount: e.amount, category: e.category, date: e.date, note: e.label, bill: e.billObj.id, label: e.label };
      render(); window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' });
    } }, icon('pencil'));
    return h('li', { class: 'mn-row ' + cls, style: `--i:${Math.min(i, 12)}` },
      h('span', { class: 'mn-row-ico' }, icon(catIcon(e.category, e.kind))),
      h('span', { class: 'mn-row-main' }, h('b', null, e.label), h('span', { class: 'muted' }, `${fmt(e.date, { day: 'numeric', month: 'short' })} · ${sub}`)),
      h('b', { class: 'mn-row-amt' }, sign + rs(e.amount)),
      action || h('span'));
  }
  function deleteAdjust(e) {
    M.form = null;
    if (!confirm('Delete this balance check adjustment?')) return;
    sendQuick('deleteMoney', { id: e.id }); toast('Deleted'); render();
  }

  /* ---------- bills and SIPs ---------- */
  function billsCard() {
    const bills = data().bills, ro = S.readOnly, ym = ymOf(clampDate(todayKey()));
    const active = b => (!b.until || b.until >= ym);
    const monthly = bills.filter(active).reduce((t, b) => t + (b.kind === 'Bill' && !b.variable ? b.amount : 0), 0);
    const sav = bills.filter(active).reduce((t, b) => t + (b.kind === 'Saving' && !b.variable ? b.amount : 0), 0);
    const open = M.billsOpen || !!M.billForm;
    const bar = h('button', { class: 'bought-bar', type: 'button', 'aria-expanded': String(open), onclick: () => { M.billsOpen = !open; M.billForm = null; render(); } },
      h('span', { class: 'bought-bar-ico' }, icon('calendar-repeat')), h('span', { class: 'bought-bar-title' }, 'Monthly bills & SIPs'),
      h('span', { class: 'pill' }, String(bills.filter(active).length)), h('span', { class: 'spacer' }),
      h('b', null, bills.length ? `${rs(monthly)}${sav ? ` + ${rs(sav)} saved` : ''}` : ''), h('span', { class: 'bought-chev' }, icon('chevron-down')));
    const inner = h('div', { class: 'bought-inner' },
      h('ul', { class: 'bought-list' },
        bills.length ? bills.map(b => M.billForm?.id === b.id ? h('li', null, billForm()) : h('li', { class: 'bought-item mn-bill' + (active(b) ? '' : ' stopped') },
          h('span', { class: 'tb-ico' + (b.kind === 'Saving' ? ' done' : '') }, icon(b.kind === 'Saving' ? 'pig-money' : catIcon(b.category, 'spend'))),
          h('span', { class: 'bought-name' }, h('b', null, b.name), h('span', { class: 'muted' }, `Every month on the ${C_ord(b.day)}${b.kind === 'Saving' ? ' · saving' : ''}${active(b) ? '' : ` · stopped after ${ymLabel(b.until)}`}`)),
          h('span', { class: 'tb-cost' }, b.variable ? 'varies' : rs(b.amount)),
          ro ? h('span') : h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Edit ${b.name}`, onclick: () => { M.billForm = { ...b, amount: b.variable ? '' : b.amount }; render(); } }, icon('pencil'))))
          : h('li', { class: 'sub mn-bills-empty' }, 'Add rent, EMI, phone, subscriptions or a SIP once, and they count every month on their day.'),
        M.billForm && !M.billForm.id ? h('li', null, billForm()) : null),
      ro || M.billForm ? null : h('div', { class: 'row-actions mn-bill-add' }, h('button', { class: 'btn small ghost', type: 'button', onclick: () => {
        M.billForm = { name: '', amount: '', day: Math.min(28, parseKey(todayKey()).getDate()), category: 'Bills', kind: 'Bill', variable: false, from: ym, until: '' }; render();
      } }, icon('plus'), ' Add a bill or SIP')));
    return h('div', { class: 'card bought-card mn-bills' }, bar, h('div', { class: 'bought-wrap', 'data-open': String(open) }, inner));
  }
  const C_ord = n => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');

  function billForm() {
    const f = M.billForm;
    const name = h('input', { type: 'text', maxlength: '60', value: f.name, placeholder: 'e.g. Rent, Phone, SIP', 'aria-label': 'Name' });
    const kind = h('select', { 'aria-label': 'Type' }, h('option', { value: 'Bill' }, 'Bill (spending)'), h('option', { value: 'Saving' }, 'Saving (SIP, RD…)'));
    kind.value = f.kind;
    const amt = h('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', value: f.amount, placeholder: '₹', 'aria-label': 'Amount' });
    const vari = h('input', { type: 'checkbox', checked: !!f.variable });
    const day = h('input', { type: 'number', min: '1', max: '28', step: '1', value: f.day, 'aria-label': 'Day of month' });
    const cat = h('select', { 'aria-label': 'Category' }, [...CATS.Spend, ...CATS.Saving].map(([c]) => h('option', { value: c }, c)));
    cat.value = f.category;
    const from = h('input', { type: 'month', value: f.from, min: ymOf(startEntry().date), max: ymOf(S.idx.last), 'aria-label': 'From month' });
    const sync = () => { amt.disabled = vari.checked; amt.placeholder = vari.checked ? 'Asked each month' : '₹'; };
    vari.addEventListener('change', sync); sync();
    const save = () => {
      const p = { id: f.id || rid(), name: name.value.trim(), kind: kind.value, amount: vari.checked ? '' : Number(amt.value), variable: vari.checked, day: Number(day.value), category: cat.value, from: from.value, until: f.until || '' };
      if (!p.name) return toast('Give it a name.', true);
      if (!p.variable && !(p.amount > 0)) return toast('Enter the monthly amount, or tick "Changes every month".', true);
      if (!(p.day >= 1 && p.day <= 28)) return toast('Pick a day from 1 to 28.', true);
      if (!/^\d{4}-\d{2}$/.test(p.from)) return toast('Pick the first month.', true);
      sendQuick('saveBill', p); M.billForm = null; M.billsOpen = true; toast('Saved'); render();
    };
    return h('div', { class: 'mn-form bill' },
      h('div', { class: 'mn-form-row' }, h('label', null, 'Name', name), h('label', null, 'Type', kind)),
      h('div', { class: 'mn-form-row' }, h('label', null, 'Amount ₹', amt), h('label', null, 'Day of month', day)),
      h('label', { class: 'mn-check-line' }, vari, ' Changes every month (electricity, credit card…): ask me for the amount'),
      h('div', { class: 'mn-form-row' }, h('label', null, 'Category', cat), h('label', null, 'From', from)),
      h('div', { class: 'row-actions' },
        f.id ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => {
          const ym = ymOf(clampDate(todayKey()));
          if (!confirm(`Stop ${f.name} after ${ymLabel(ym)}? Past months stay counted.`)) return;
          sendQuick('saveBill', { ...f, amount: f.variable ? '' : Number(f.amount), until: ym }); M.billForm = null; toast(`${f.name} stops after ${ymLabel(ym)}`); render();
        } }, icon('player-stop'), ' Stop') : null,
        f.id ? h('button', { class: 'btn small ghost danger-text', type: 'button', onclick: () => {
          if (!confirm(`Delete ${f.name} completely? Past months will no longer count it.`)) return;
          sendQuick('deleteBill', { id: f.id }); M.billForm = null; toast('Deleted'); render();
        } }, icon('trash')) : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => { M.billForm = null; render(); } }, 'Cancel'),
        h('button', { class: 'btn small primary', type: 'button', onclick: save }, 'Save')));
  }

  /* ---------- page ---------- */
  function render() {
    const body = document.getElementById('moneyBody');
    if (!body) return;
    if (!S.data || S.groupMode) return fill(body, h('p', { class: 'sub' }, 'Open your own year to track money.'));
    if (!S.data.sheets.buy) S.data.sheets.buy ||= null;
    const st = startEntry();
    if (!st) return fill(body, h('div', { class: 'mn-narrow' }, setupCard()));
    const t = clampDate(todayKey());
    if (!M.month || M.month < ymOf(st.date) || M.month > ymOf(S.idx.last)) M.month = ymOf(t) < ymOf(st.date) ? ymOf(st.date) : ymOf(t);
    fill(body, h('div', { class: 'mn-layout' }, h('div', { class: 'mn-col' }, hero(), monthCard()), h('div', { class: 'mn-col' }, billsCard())));
    M.flash = false;
  }

  /** for the Assistant: a summary for [a, b] */
  function summary(a, b) {
    const st = startEntry();
    if (!st) return { available: false, reason: 'Money tracking has not been started yet (Money page → Start tracking).' };
    const list = events(a < st.date ? st.date : a, b > todayKey() ? todayKey() : b), t = totals(list);
    const income = t.income + Math.max(0, t.adjust), spent = t.spend + Math.max(0, -t.adjust);
    return {
      tracking_since: st.date, starting_balance: st.amount, balance_now: r2(balance()),
      period: { income: r2(income), spent: r2(spent), saved: r2(t.saving), left: r2(income - spent - t.saving) },
      spent_by_category: Object.fromEntries(Object.entries(t.byCat).sort((x, y) => y[1] - x[1]).map(([k, v]) => [k, r2(v)])),
      income_entries: list.filter(e => e.kind === 'income').map(e => ({ date: e.date, amount: e.amount, what: e.label })),
      biggest_spends: list.filter(e => e.kind === 'spend').sort((x, y) => y.amount - x.amount).slice(0, 5).map(e => ({ date: e.date, amount: e.amount, what: e.label, category: e.category })),
      monthly_bills: data().bills.filter(x => !x.until || x.until >= ymOf(todayKey())).map(x => ({ name: x.name, amount: x.variable ? 'varies' : x.amount, day: x.day, kind: x.kind })),
      note: 'Income varies month to month and is logged when it arrives. Untracked = gaps found in balance checks.'
    };
  }

  return { render, applyLocal, balance, events, totals, summary };
})();
