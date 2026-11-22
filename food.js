/* Food: a daily food log with calories, protein, carbs and fat.
 * Type what you ate ("2 idli, sambar, filter coffee"); the Apps Script asks Groq for an estimate, guided by a
 * reference list of common Indian foods, and you can correct every number before and after saving.
 * The daily target comes from weight (latest weigh-in), height, age, gender and activity (Mifflin-St Jeor),
 * adjusted to lose / keep / gain, unless a fixed target is set.
 * Rows live in the year file's "Food Log" sheet; the target settings in "Body Settings". */
'use strict';

const Food = (() => {
  const MEALS = [['Breakfast', 'coffee'], ['Lunch', 'salad'], ['Snacks', 'cookie'], ['Dinner', 'tools-kitchen-2']];
  const ACTIVITY = [['Sedentary', 1.2, 'Mostly sitting, little exercise'], ['Light', 1.375, 'Light exercise 1-3 days a week'],
    ['Moderate', 1.55, 'Exercise 3-5 days a week'], ['Active', 1.725, 'Hard exercise 6-7 days a week'], ['Very active', 1.9, 'Physical job or training twice a day']];
  const GOALS = [['Lose', 'Lose weight (about 0.5 kg a week)'], ['Keep', 'Keep my weight'], ['Gain', 'Gain weight slowly']];
  const F = { date: null, meal: null, draft: [], text: '', busy: false, editId: null, setup: false };

  const r1 = n => Math.round((Number(n) || 0) * 10) / 10;
  const rid = () => { const a = new Uint8Array(8); crypto.getRandomValues(a); return [...a].map(b => (b % 36).toString(36)).join('') + Date.now().toString(36).slice(-4); };
  const mealFor = hm => { const h = Number(String(hm || nowHM()).slice(0, 2)); return h < 11 ? 'Breakfast' : h < 16 ? 'Lunch' : h < 19 ? 'Snacks' : 'Dinner'; };
  const dayItems = d => S.data.food?.days?.[d] || [];
  const sum = items => items.reduce((t, i) => ({ kcal: t.kcal + (+i.kcal || 0), protein: t.protein + (+i.protein || 0), carbs: t.carbs + (+i.carbs || 0), fat: t.fat + (+i.fat || 0) }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  const ageOn = (dob, d) => { const [y, m, dd] = dob.split('-').map(Number), [Y, M, D] = d.split('-').map(Number); return Y - y - (M < m || (M === m && D < dd) ? 1 : 0); };

  /** The day's targets, or { missing:[...] } when something needed is not set yet. */
  function targets(date) {
    const diet = S.data.diet || {}, cm = S.data.profile?.height, lw = latestWeigh(date) || latestWeigh(S.idx.last);
    const gender = S.user?.gender || '';
    const missing = [];
    if (!diet.dob || !diet.activity || !diet.goal) missing.push('your date of birth, activity and goal');
    if (!cm) missing.push('your height (Settings)');
    if (!lw) missing.push('a weight entry (Today)');
    const kg = lw?.kg;
    if (missing.length && !diet.target) return { missing };
    let kcal = diet.target || null, bmr = null, tdee = null;
    if (!missing.length) {
      const age = ageOn(diet.dob, date), s = gender === 'male' ? 5 : gender === 'female' ? -161 : -78;
      bmr = 10 * kg + 6.25 * cm - 5 * age + s;
      tdee = bmr * (ACTIVITY.find(a => a[0] === diet.activity)?.[1] || 1.2);
      const floor = gender === 'male' ? 1500 : gender === 'female' ? 1200 : 1350;
      const calc = diet.goal === 'Lose' ? Math.max(floor, tdee - 500) : diet.goal === 'Gain' ? tdee + 300 : tdee;
      if (!kcal) kcal = Math.round(calc / 10) * 10;
    }
    const perKg = diet.goal === 'Lose' ? 1.4 : diet.goal === 'Gain' ? 1.6 : 1.2;
    const protein = kg ? Math.round(perKg * kg) : Math.round(kcal * 0.2 / 4);
    const fat = Math.round(kcal * 0.25 / 9);
    const carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
    return { kcal, protein, carbs, fat, bmr, tdee, kg, fixed: !!diet.target, missing };
  }

  /* ---------- local updates (called from app.js applyLocal) ---------- */
  function applyLocal(action, p) {
    const days = ((S.data.food ||= { days: {} }).days);
    if (action === 'addFood') {
      const list = (days[p.date] ||= []);
      p.items.forEach(it => list.push({ id: it.id, time: p.time || '', meal: p.meal, food: it.food, qty: it.qty || '', kcal: r1(it.kcal), protein: r1(it.protein), carbs: r1(it.carbs), fat: r1(it.fat) }));
    } else if (action === 'updateFood' || action === 'deleteFood') {
      for (const d of Object.keys(days)) {
        const i = days[d].findIndex(x => x.id === p.id);
        if (i < 0) continue;
        if (action === 'deleteFood') days[d].splice(i, 1);
        else Object.assign(days[d][i], { meal: p.meal || days[d][i].meal, food: p.food, qty: p.qty || '', kcal: r1(p.kcal), protein: r1(p.protein), carbs: r1(p.carbs), fat: r1(p.fat) });
        break;
      }
    } else if (action === 'saveDiet') {
      S.data.diet = { dob: p.dob, activity: p.activity, goal: p.goal, target: p.target ? Number(p.target) : null };
    }
  }

  /* ---------- pieces ---------- */
  const SHORT = { Calories: 'kcal', 'Protein g': 'P g', 'Carbs g': 'C g', 'Fat g': 'F g' };
  const numIn = (v, label, max, step = '0.1') => h('input', { type: 'number', min: '0', max: String(max), step, inputmode: 'decimal', value: v === 0 || v ? v : '', 'aria-label': label, placeholder: SHORT[label] || '', class: 'food-num' });

  function bar(label, val, goal, unit, cls) {
    const pct = goal ? Math.min(100, Math.round(val / goal * 100)) : 0, over = goal && val > goal * 1.05;
    return h('div', { class: 'food-bar ' + cls + (over ? ' over' : '') },
      h('div', { class: 'food-bar-head' }, h('span', null, label), h('b', null, `${Math.round(val)}${goal ? ` / ${goal}` : ''} ${unit}`)),
      h('div', { class: 'food-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(goal || 0), 'aria-valuenow': String(Math.round(val)), 'aria-label': label },
        h('div', { class: 'food-fill', style: `width:${goal ? pct : 0}%` })));
  }

  function summaryCard(date) {
    const t = targets(date), tot = sum(dayItems(date));
    if (t.missing?.length && !t.kcal) {
      return h('div', { class: 'card food-summary' },
        h('div', { class: 'food-big' }, h('span', { class: 'food-kcal' }, String(Math.round(tot.kcal))), h('span', { class: 'muted' }, 'kcal eaten')),
        h('p', { class: 'sub' }, `To see your daily target, add ${t.missing.join(', ')}.`),
        h('div', { class: 'row-actions' }, h('button', { class: 'btn small primary', type: 'button', onclick: () => { F.setup = true; render(); } }, icon('target'), ' Set up my target')),
        macroLine(tot));
    }
    const left = t.kcal - tot.kcal;
    return h('div', { class: 'card food-summary' },
      h('div', { class: 'food-top' },
        h('div', { class: 'food-big' }, h('span', { class: 'food-kcal' }, String(Math.round(tot.kcal))), h('span', { class: 'muted' }, `of ${t.kcal} kcal`)),
        h('div', { class: 'food-left ' + (left < -100 ? 'bad' : 'good') }, h('b', null, String(Math.abs(Math.round(left)))), h('span', null, left < 0 ? 'kcal over' : 'kcal left'))),
      bar('Calories', tot.kcal, t.kcal, 'kcal', 'kcal'),
      h('div', { class: 'food-macros' },
        bar('Protein', tot.protein, t.protein, 'g', 'protein'), bar('Carbs', tot.carbs, t.carbs, 'g', 'carbs'), bar('Fat', tot.fat, t.fat, 'g', 'fat')),
      h('details', { class: 'food-how' },
        h('summary', null, 'How is my target worked out?'),
        t.fixed ? h('p', { class: 'sub' }, 'You set a fixed calorie target. Protein, carbs and fat are split from it.')
          : h('p', { class: 'sub' }, `Your body burns about ${Math.round(t.bmr)} kcal at rest (Mifflin-St Jeor, from ${t.kg} kg, ${S.data.profile.height} cm, age ${ageOn(S.data.diet.dob, date)}). `
            + `With ${S.data.diet.activity.toLowerCase()} activity that is about ${Math.round(t.tdee)} kcal a day; your goal (${S.data.diet.goal.toLowerCase()}) sets the target to ${t.kcal} kcal. `
            + `Protein ${t.protein} g (${S.data.diet.goal === 'Lose' ? 1.4 : S.data.diet.goal === 'Gain' ? 1.6 : 1.2} g per kg), fat 25% of calories, carbs the rest. These are estimates, not medical advice.`),
        h('button', { class: 'linkbtn', type: 'button', onclick: () => { F.setup = true; render(); } }, 'Change my details or target')));
  }
  const macroLine = tot => h('p', { class: 'sub food-macro-line' }, `Protein ${r1(tot.protein)} g · Carbs ${r1(tot.carbs)} g · Fat ${r1(tot.fat)} g`);

  function setupCard() {
    const d = S.data.diet || {};
    const dob = h('input', { type: 'date', value: d.dob || '', max: todayKey(), required: true });
    const act = h('select', { required: true }, h('option', { value: '' }, 'Choose…'), ACTIVITY.map(([v, , l]) => { const o = h('option', { value: v }, `${v}: ${l}`); if (d.activity === v) o.selected = true; return o; }));
    const goal = h('select', { required: true }, GOALS.map(([v, l]) => { const o = h('option', { value: v }, l); if ((d.goal || 'Keep') === v) o.selected = true; return o; }));
    const fixed = h('input', { type: 'number', min: '800', max: '6000', step: '10', placeholder: 'Calculated', value: d.target || '', inputmode: 'numeric' });
    const gender = S.user?.gender;
    return h('form', { class: 'card settings food-setup', onsubmit: async e => {
      e.preventDefault();
      const p = { dob: dob.value, activity: act.value, goal: goal.value, target: fixed.value ? Number(fixed.value) : '' };
      if (!p.dob || !p.activity) return toast('Fill in your date of birth and activity.', true);
      if (p.target !== '' && !(p.target >= 800 && p.target <= 6000)) return toast('Calorie target should be between 800 and 6000.', true);
      F.setup = false;
      await sendQuick('saveDiet', p);
      render();
    } },
      h('h2', null, 'Your calorie target'),
      h('p', { class: 'sub' }, `Worked out from your latest weight, your height (Settings), age and ${gender ? `gender (${gender})` : 'gender'}. Saved in this year's sheet.`),
      h('label', null, 'Date of birth', dob),
      h('label', null, 'Activity', act),
      h('label', null, 'Goal', goal),
      h('label', null, 'Fixed target (optional, kcal)', fixed),
      !S.data.profile?.height ? h('p', { class: 'sub err' }, 'Add your height in Settings → Body & water too.') : null,
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { F.setup = false; render(); } }, 'Cancel'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary', type: 'submit' }, icon('device-floppy'), ' Save')));
  }

  /* ---------- adding food ---------- */
  function draftRows(refresh) {
    if (!F.draft.length) return null;
    const totText = () => { const t = sum(F.draft); return `Total ${Math.round(t.kcal)} kcal · P ${r1(t.protein)} g · C ${r1(t.carbs)} g · F ${r1(t.fat)} g`; };
    const totEl = h('p', { class: 'sub food-draft-tot' }, totText());
    return h('div', { class: 'food-draft' },
      h('div', { class: 'food-grid food-grid-head', 'aria-hidden': 'true' }, h('span', null, 'Food'), h('span', null, 'Amount'), h('span', null, 'kcal'), h('span', null, 'P'), h('span', null, 'C'), h('span', null, 'F'), h('span')),
      F.draft.map((it, i) => {
        const bind = (el, k, num) => { el.addEventListener('input', () => { it[k] = num ? Number(el.value || 0) : el.value; totEl.textContent = totText(); }); return el; };
        return h('div', { class: 'food-grid' },
          bind(h('input', { type: 'text', value: it.food, maxlength: '80', 'aria-label': 'Food', placeholder: 'Food' }), 'food'),
          bind(h('input', { type: 'text', value: it.qty, maxlength: '40', 'aria-label': 'Amount', placeholder: 'e.g. 2 pieces' }), 'qty'),
          bind(numIn(it.kcal, 'Calories', 5000, '1'), 'kcal', true), bind(numIn(it.protein, 'Protein g', 500), 'protein', true),
          bind(numIn(it.carbs, 'Carbs g', 1000), 'carbs', true), bind(numIn(it.fat, 'Fat g', 500), 'fat', true),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove ${it.food || 'row'}`, onclick: () => { F.draft.splice(i, 1); refresh(); } }, icon('x')));
      }),
      totEl);
  }

  function recentFoods() {
    const seen = new Map();
    Object.keys(S.data.food?.days || {}).sort().reverse().forEach(d => S.data.food.days[d].slice().reverse().forEach(i => {
      const k = (i.food + '|' + i.qty).toLowerCase();
      if (!seen.has(k) && seen.size < 12) seen.set(k, i);
    }));
    return [...seen.values()];
  }

  function addCard(date) {
    const ro = S.readOnly;
    F.meal ||= date === todayKey() ? mealFor() : 'Lunch';
    const box = h('div');
    const refresh = () => fill(box, inner());
    const estimate = async btn => {
      const text = F.text.trim();
      if (!text) return toast('Type what you ate first.', true);
      F.busy = true; btn.disabled = true; btn.textContent = 'Estimating…';
      try {
        const r = S.demo ? { items: [{ food: text.slice(0, 40), qty: '1 serving', kcal: 250, protein: 8, carbs: 35, fat: 8 }], note: '' } : await api('foodEstimate', { text });
        if (!r.items.length) toast(r.note || 'No food found in that text.', true);
        F.draft.push(...r.items.map(i => ({ ...i })));
        F.text = '';
      } catch (err) { toast(err.message, true); }
      F.busy = false; refresh();
    };
    const save = () => {
      const items = F.draft.filter(i => String(i.food).trim());
      if (!items.length) return toast('Add at least one food.', true);
      if (items.some(i => !(Number(i.kcal) >= 0 && Number(i.kcal) <= 5000))) return toast('Calories should be between 0 and 5000.', true);
      sendQuick('addFood', { date, meal: F.meal, time: date === todayKey() ? nowHM() : '', items: items.map(i => ({ id: rid(), food: String(i.food).trim(), qty: String(i.qty || '').trim(), kcal: Math.round(+i.kcal || 0), protein: r1(i.protein), carbs: r1(i.carbs), fat: r1(i.fat) })) });
      toast(`Added ${items.length === 1 ? items[0].food : `${items.length} foods`} to ${F.meal}`);
      F.draft = [];
      render();
    };
    const inner = () => {
      const ta = h('textarea', { rows: '2', maxlength: '400', placeholder: 'e.g. 2 idli with sambar and coconut chutney, filter coffee', 'aria-label': 'What did you eat?', disabled: ro || F.busy });
      ta.value = F.text;
      ta.addEventListener('input', () => { F.text = ta.value; });
      ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); estimate(estBtn); } });
      const estBtn = h('button', { class: 'btn primary', type: 'button', disabled: ro || F.busy, onclick: e => estimate(e.currentTarget) }, icon('sparkles'), F.busy ? ' Estimating…' : ' Estimate calories');
      const recent = recentFoods();
      return [
        h('div', { class: 'chips food-meals', role: 'group', 'aria-label': 'Meal' }, MEALS.map(([m, ic]) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(F.meal === m), onclick: () => { F.meal = m; refresh(); } }, icon(ic), ' ', m))),
        h('label', { class: 'food-label' }, 'What did you eat?', ta),
        h('div', { class: 'row-actions food-actions' }, estBtn,
          h('button', { class: 'btn ghost', type: 'button', disabled: ro, onclick: () => { F.draft.push({ food: '', qty: '', kcal: '', protein: '', carbs: '', fat: '' }); refresh(); } }, icon('pencil-plus'), ' Enter myself')),
        recent.length ? h('div', { class: 'food-recent' }, h('span', { class: 'muted' }, 'Recent:'),
          recent.map(i => h('button', { class: 'chip', type: 'button', disabled: ro, title: `${i.kcal} kcal`, onclick: () => { F.draft.push({ food: i.food, qty: i.qty, kcal: i.kcal, protein: i.protein, carbs: i.carbs, fat: i.fat }); refresh(); } },
            `${i.food}${i.qty ? ` (${i.qty})` : ''}`))) : null,
        draftRows(refresh),
        F.draft.length ? h('div', { class: 'row-actions' },
          h('button', { class: 'btn ghost', type: 'button', onclick: () => { F.draft = []; refresh(); } }, 'Clear'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn primary', type: 'button', disabled: ro, onclick: save }, icon('plus'), ` Add to ${F.meal}`)) : null,
        h('p', { class: 'sub food-note' }, 'Estimates are approximate. Check the numbers, especially for oil, ghee and portion sizes. Uses the assistant’s daily limit.')
      ];
    };
    refresh();
    return h('div', { class: 'card food-add' }, h('h2', null, 'Add food'), box);
  }

  /* ---------- the day's log ---------- */
  function logCard(date) {
    const items = dayItems(date), ro = S.readOnly;
    if (!items.length) return h('div', { class: 'card food-log' }, h('h2', null, 'Eaten'), h('p', { class: 'sub' }, 'Nothing logged for this day yet.'));
    return h('div', { class: 'card food-log' }, h('h2', null, 'Eaten'),
      MEALS.map(([m, ic]) => {
        const list = items.filter(i => i.meal === m);
        if (!list.length) return null;
        const t = sum(list);
        return h('div', { class: 'food-meal' },
          h('div', { class: 'food-meal-head' }, icon(ic), h('h3', null, m), h('span', { class: 'muted' }, `${Math.round(t.kcal)} kcal`)),
          list.map(i => F.editId === i.id ? editRow(i) : h('div', { class: 'food-item' },
            h('div', { class: 'food-item-name' }, h('b', null, i.food), i.qty ? h('span', { class: 'muted' }, i.qty) : null),
            h('div', { class: 'food-item-nums' }, h('b', null, `${Math.round(i.kcal)} kcal`), h('span', { class: 'muted' }, `P ${r1(i.protein)} · C ${r1(i.carbs)} · F ${r1(i.fat)}`)),
            ro ? null : h('div', { class: 'food-item-acts' },
              h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Edit ${i.food}`, onclick: () => { F.editId = i.id; render(); } }, icon('pencil')),
              h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Delete ${i.food}`, onclick: () => {
                if (!confirm(`Delete ${i.food}?`)) return;
                sendQuick('deleteFood', { id: i.id }); render();
              } }, icon('trash'))))));
      }));
  }

  function editRow(i) {
    const e = { ...i };
    const bind = (el, k, num) => { el.addEventListener('input', () => { e[k] = num ? Number(el.value || 0) : el.value; }); return el; };
    const meal = h('select', { 'aria-label': 'Meal' }, MEALS.map(([m]) => { const o = h('option', { value: m }, m); if (m === i.meal) o.selected = true; return o; }));
    meal.addEventListener('change', () => { e.meal = meal.value; });
    return h('div', { class: 'food-edit' },
      h('div', { class: 'food-grid' },
        bind(h('input', { type: 'text', value: i.food, maxlength: '80', 'aria-label': 'Food' }), 'food'),
        bind(h('input', { type: 'text', value: i.qty, maxlength: '40', 'aria-label': 'Amount' }), 'qty'),
        bind(numIn(i.kcal, 'Calories', 5000, '1'), 'kcal', true), bind(numIn(i.protein, 'Protein g', 500), 'protein', true),
        bind(numIn(i.carbs, 'Carbs g', 1000), 'carbs', true), bind(numIn(i.fat, 'Fat g', 500), 'fat', true), h('span')),
      h('div', { class: 'row-actions' }, h('label', { class: 'food-meal-sel' }, 'Meal ', meal), h('span', { class: 'spacer' }),
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => { F.editId = null; render(); } }, 'Cancel'),
        h('button', { class: 'btn small primary', type: 'button', onclick: () => {
          if (!String(e.food).trim()) return toast('Enter a food name.', true);
          F.editId = null;
          sendQuick('updateFood', { id: i.id, meal: e.meal, food: String(e.food).trim(), qty: String(e.qty || '').trim(), kcal: Math.round(+e.kcal || 0), protein: r1(e.protein), carbs: r1(e.carbs), fat: r1(e.fat) });
          render();
        } }, 'Save')));
  }

  /* ---------- page ---------- */
  function dateBar() {
    const t = todayKey();
    const go = d => { F.date = clampDate(d); F.editId = null; render(); };
    const input = h('input', { type: 'date', value: F.date, min: S.idx.first, max: S.idx.last, 'aria-label': 'Day' });
    input.addEventListener('change', () => input.value && go(input.value));
    return h('div', { class: 'food-datebar' },
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Previous day', disabled: F.date <= S.idx.first, onclick: () => go(addDays(F.date, -1)) }, icon('chevron-left')),
      h('b', null, F.date === t ? 'Today' : fmt(F.date, { weekday: 'short', day: 'numeric', month: 'short' })),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next day', disabled: F.date >= S.idx.last, onclick: () => go(addDays(F.date, 1)) }, icon('chevron-right')),
      input,
      F.date !== t && t >= S.idx.first && t <= S.idx.last ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => go(t) }, 'Today') : null);
  }

  function render() {
    const body = document.getElementById('foodBody');
    if (!body) return;
    if (!S.data || S.groupMode) return fill(body, h('p', { class: 'sub' }, 'Open your own year to log food.'));
    if (!F.date || F.date < S.idx.first || F.date > S.idx.last) F.date = clampDate(todayKey());
    const needSetup = F.setup;
    fill(body, dateBar(),
      needSetup ? h('div', { class: 'settings-grid' }, setupCard()) : null,
      h('div', { class: 'food-layout' }, h('div', { class: 'food-col' }, summaryCard(F.date), logCard(F.date)), h('div', { class: 'food-col' }, addCard(F.date))));
  }

  return { render, applyLocal, targets, sum };
})();
