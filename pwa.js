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
