/* Web app (PWA) glue: registers the service worker, offers updates, shows install help in Settings,
 * and notes when the phone is offline. Kept separate from app.js so the app still runs if this fails. */
'use strict';
(() => {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let installEvent = null;

  /* ---------- service worker + updates ---------- */
  function updateBar(reg) {
    if (document.getElementById('updateBar')) return;
    const bar = document.createElement('div');
    bar.id = 'updateBar'; bar.className = 'pwa-bar'; bar.setAttribute('role', 'status');
    bar.innerHTML = '<span>New version available</span>';
    const btn = document.createElement('button');
    btn.className = 'btn small primary'; btn.type = 'button'; btn.textContent = 'Reload';
    btn.onclick = () => { btn.disabled = true; reg.waiting?.postMessage('SKIP_WAITING'); };
    bar.append(btn);
    document.body.append(bar);
  }

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', async () => {
      try {
        const reg = await navigator.serviceWorker.register('sw.js');
        const hadController = !!navigator.serviceWorker.controller;   // false on the very first visit: nothing to update
        const watch = w => w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) updateBar(reg); });
        if (reg.waiting && hadController) updateBar(reg);
        watch(reg.installing);
        reg.addEventListener('updatefound', () => watch(reg.installing));
        let reloading = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloading) { reloading = true; location.reload(); } });
        // installed apps stay open for days: look for a new version whenever the app comes back to the front
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
      } catch (err) { console.warn('Service worker not registered', err); }
    });
  }

  /* ---------- install help (Settings) ---------- */
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvent = e; renderInstall(); });
  window.addEventListener('appinstalled', () => { installEvent = null; renderInstall(true); });

  function renderInstall(justInstalled) {
    const box = document.getElementById('installBox');
    if (!box) return;
    box.textContent = '';
    const p = (text, cls = 'sub') => { const el = document.createElement('p'); el.className = cls; el.textContent = text; box.append(el); return el; };
    if (standalone() || justInstalled) {
      p(justInstalled ? 'Installed. Open Life Tracker from your home screen.' : 'You’re using the installed app.');
      return;
    }
    if (installEvent) {
      p('Add Life Tracker to your home screen. It opens full screen like an app, with no browser bar.');
      const btn = document.createElement('button');
      btn.className = 'btn primary'; btn.type = 'button';
      btn.innerHTML = '<i class="ti ti-download" aria-hidden="true"></i> Install app';
      btn.onclick = async () => {
        const ev = installEvent; installEvent = null;
        ev.prompt();
        const { outcome } = await ev.userChoice;
        if (outcome !== 'accepted') { installEvent = null; renderInstall(); }
      };
      const row = document.createElement('div'); row.className = 'row-actions'; row.append(btn); box.append(row);
      return;
    }
    if (isIOS) {
      p('On iPhone: open this page in Safari, tap the Share button, then “Add to Home Screen”.');
      p('The home-screen app keeps its own sign-in, so you’ll sign in once more inside it.');
      return;
    }
    p('On Android: open this page in Chrome, tap the ⋮ menu, then “Add to Home screen” or “Install app”. On a computer, use the install icon in Chrome’s address bar.');
  }

  /* ---------- offline note ---------- */
  function offlineNote() {
    let el = document.getElementById('offlineBar');
    if (navigator.onLine) { el?.remove(); return; }
    if (el) return;
    el = document.createElement('div');
    el.id = 'offlineBar'; el.className = 'pwa-bar offline'; el.setAttribute('role', 'status');
    el.textContent = 'You’re offline. Saving and loading your sheet need a connection.';
    document.body.append(el);
  }
  window.addEventListener('online', offlineNote);
  window.addEventListener('offline', offlineNote);

  document.addEventListener('DOMContentLoaded', () => {
    if (standalone()) document.documentElement.classList.add('standalone');
    renderInstall();
    offlineNote();
  });
})();

/** Home-screen shortcuts open ./?tab=buy etc. Returns that tab once (if it is visible for this person), else the default. */
function startTab(fallback) {
  if (startTab.used) return fallback;
  startTab.used = true;
  const t = new URLSearchParams(location.search).get('tab');
  if (!t) return fallback;
  try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
  const btn = document.querySelector(`.nav-btn[data-tab="${CSS.escape(t)}"]`);
  return btn && !btn.hidden ? t : fallback;
}

/* =========================================================
 * Phone notifications: each phone that turns them on saves a token (push_tokens) so the admin's
 * messages also arrive as real notifications, even when the app is closed. Settings has the switch.
 * ======================================================= */
const Push = (() => {
  const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js';
  const KEY = 'lt.pushId', ASKED = 'lt.pushAsked';
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ls = { get: k => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    del: k => { try { localStorage.removeItem(k); } catch { /* ignore */ } } };
  let profile = null, sdk = null;
  // the person's own choice on this phone; the browser permission alone does not turn it back on
  const optKey = () => 'lt.pushOn.' + (profile?.uid || '');

  const vapid = () => window.APP_CONFIG?.vapidKey || '';
  const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
  const canAsk = () => supported() && vapid() && (!isIOS || standalone());

  function loadSdk() {
    if (window.firebase?.messaging) return Promise.resolve();
    sdk ||= new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = SDK; s.onload = res; s.onerror = () => { sdk = null; rej(new Error('Could not load the notification library.')); };
      document.head.append(s);
    });
    return sdk;
  }
  async function hash(text) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 40);
  }
  function device() {
    const ua = navigator.userAgent;
    const os = /android/i.test(ua) ? 'Android' : isIOS ? (/ipad/i.test(ua) ? 'iPad' : 'iPhone') : /windows/i.test(ua) ? 'Windows' : /mac/i.test(ua) ? 'Mac' : 'Device';
    const br = /edg\//i.test(ua) ? 'Edge' : /samsungbrowser/i.test(ua) ? 'Samsung Internet' : /chrome|crios/i.test(ua) ? 'Chrome' : /firefox|fxios/i.test(ua) ? 'Firefox' : /safari/i.test(ua) ? 'Safari' : 'browser';
    return `${os} · ${br}${standalone() ? ' (app)' : ''}`;
  }

  /** Gets this phone's token and saves it for the signed-in person. */
  async function register() {
    await loadSdk();
    const reg = await navigator.serviceWorker.ready;
    const token = await firebase.messaging().getToken({ vapidKey: vapid(), serviceWorkerRegistration: reg });
    if (!token) throw new Error('This browser did not give a notification token.');
    const id = await hash(token), old = ls.get(KEY);
    if (old && old !== id) await Account.deletePushToken(old);
    await Account.savePushToken(id, token, device());
    ls.set(KEY, id);
  }

  async function enable(btn) {
    if (btn) btn.disabled = true;
    try {
      const p = await Notification.requestPermission();
      if (p === 'granted') { await register(); ls.set(optKey(), '1'); toast('Notifications are on for this phone'); }
      else toast('Notifications were not allowed', true);
    } catch (err) { toast(err.message, true); }
    hideNudge(); render();
  }
  async function disable(btn) {
    if (btn) btn.disabled = true;
    const id = ls.get(KEY);
    if (id) await Account.deletePushToken(id);
    try { await loadSdk(); await firebase.messaging().deleteToken(); } catch { /* token already gone */ }
    ls.del(KEY); ls.del(optKey());
    toast('Notifications are off for this phone');
    render();
  }

  function render() {
    const box = document.getElementById('pushBox');
    if (!box) return;
    const card = box.closest('.card');
    if (card) card.hidden = !profile || profile.role === 'admin';
    box.textContent = '';
    const p = (t, cls = 'sub') => { const e = document.createElement('p'); e.className = cls; e.textContent = t; box.append(e); };
    const button = (label, cls, fn, ico) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ' + cls;
      b.innerHTML = `<i class="ti ti-${ico}" aria-hidden="true"></i> `; b.append(label); b.onclick = () => fn(b);
      const row = document.createElement('div'); row.className = 'row-actions'; row.append(b); box.append(row);
    };
    if (!vapid()) return p('Phone notifications are not set up yet. The admin needs to add the Web Push key to config.js (see README).');
    if (isIOS && !standalone()) return p('On iPhone, install the app first (Install app above), open it from the home screen, then turn notifications on here.');
    if (!supported()) return p('This browser cannot show notifications. Try Chrome on Android, or the installed app on iPhone.');
    if (Notification.permission === 'denied') return p('Notifications are blocked for this site. Allow them in your phone’s settings for this browser or app, then come back here.');
    if (Notification.permission === 'granted' && ls.get(KEY) && ls.get(optKey())) {
      p('On for this phone. Messages from the admin arrive as notifications, even when the app is closed.');
      return button('Turn off', 'ghost', disable, 'bell-off');
    }
    p('Get messages from the admin as notifications on this phone, even when the app is closed.');
    button('Turn on notifications', 'primary', enable, 'bell');
  }

  /* one-time nudge after sign-in, so people find the switch */
  function hideNudge() { document.getElementById('pushNudge')?.remove(); }
  function nudge() {
    if (!profile || profile.role === 'admin' || !canAsk() || Notification.permission !== 'default' || ls.get(ASKED)) return;
    if (document.querySelector('.modal-overlay') || document.getElementById('updateBar')) { setTimeout(nudge, 4000); return; }
    ls.set(ASKED, '1');
    const bar = document.createElement('div');
    bar.id = 'pushNudge'; bar.className = 'pwa-bar'; bar.setAttribute('role', 'status');
    bar.innerHTML = '<span>Get admin messages on your phone?</span>';
    const on = document.createElement('button'); on.className = 'btn small primary'; on.type = 'button'; on.textContent = 'Turn on';
    on.onclick = () => enable(on);
    const no = document.createElement('button'); no.className = 'btn small ghost pwa-x'; no.type = 'button'; no.setAttribute('aria-label', 'Not now');
    no.innerHTML = '<i class="ti ti-x" aria-hidden="true"></i>'; no.onclick = hideNudge;
    bar.append(on, no);
    document.body.append(bar);
  }

  document.addEventListener('DOMContentLoaded', render);
  return {
    onSignIn(p) {
      profile = p; render();
      if (p.role !== 'admin' && ls.get(optKey()) && supported() && vapid() && Notification.permission === 'granted' && (!isIOS || standalone())) {
        register().then(render).catch(err => console.warn('Could not refresh the notification token', err));
      }
      setTimeout(nudge, 12000);
    },
    /** Removes this phone's token before signing out, so the next person on this phone does not get these messages. */
    async beforeSignOut() {
      const id = ls.get(KEY);
      profile = null; hideNudge();
      if (id) { await Account.deletePushToken(id); ls.del(KEY); }
    }
  };
})();
