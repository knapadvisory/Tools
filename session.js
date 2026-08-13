// Session UI for the KNAP Tools access gate. Included by every page.
// - Adds a "Sign out" button to the header when the site is gated.
// - Per-TAB sign-in: a marker in sessionStorage dies when the tab closes, so
//   a new or reopened tab shows an opaque key screen over the page until the
//   key is entered — even if the browser-wide cookie is still valid.
// - 10 minutes before the session's time limit, shows a warning popup with a
//   live countdown: [Continue] extends the session in place (NO reload — the
//   page's in-progress work is untouched), [Sign out & close] ends it.
// - If time runs out unanswered, the popup switches to asking for the access
//   key; entering it resumes in place, still without losing the page's data.
(function () {
  var WARN_BEFORE = 10 * 60 * 1000; // warn 10 minutes before expiry
  var TAB_FLAG = 'knap_tab';
  var exp = 0, warnTimer = 0, tick = 0;

  function tabOk() { try { return !!sessionStorage.getItem(TAB_FLAG); } catch (e) { return true; } }
  function markTab() { try { sessionStorage.setItem(TAB_FLAG, '1'); } catch (e) {} }
  function unmarkTab() { try { sessionStorage.removeItem(TAB_FLAG); } catch (e) {} }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  // ---------- styles (uses the page's own CSS variables) ----------
  var css = [
    '.sess-overlay{position:fixed;inset:0;background:rgba(15,17,23,.55);display:none;',
    'align-items:center;justify-content:center;z-index:1000;padding:24px}',
    '.sess-overlay.show{display:flex}',
    // Fully opaque for the per-tab key screen: nothing readable behind it.
    '.sess-overlay.lock{background:var(--bg,#f4f5f8)}',
    '.sess-card{width:100%;max-width:400px;background:var(--surface,#fff);color:var(--text,#1d1c1d);',
    'border:1px solid var(--border,#e4e6ec);border-radius:16px;padding:28px;text-align:center;',
    'box-shadow:0 12px 40px rgba(0,0,0,.35)}',
    '.sess-overlay.lock .sess-card{max-width:440px;padding:36px 32px}',
    '.sess-logo{display:none;font-size:44px;margin-bottom:8px}',
    '.sess-overlay.lock .sess-logo{display:block}',
    '.sess-eyebrow{display:none;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;',
    'color:var(--accent,#4f46e5);margin-bottom:4px}',
    '.sess-overlay.lock .sess-eyebrow{display:block}',
    '.sess-tools{display:none;justify-content:center;gap:16px;font-size:21px;margin:2px 0 16px;',
    'filter:grayscale(.15);opacity:.9}',
    '.sess-overlay.lock .sess-tools{display:flex}',
    '.sess-card h2{font-size:18px;margin:0 0 6px}',
    '.sess-card p{color:var(--muted,#6b7280);font-size:13.5px;margin:0 0 18px}',
    '.sess-count{font-size:30px;font-weight:700;letter-spacing:.02em;margin:2px 0 18px}',
    '.sess-row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}',
    '.sess-btn{font:inherit;font-weight:600;font-size:13.5px;padding:10px 16px;border-radius:10px;',
    'border:1px solid var(--border,#e4e6ec);background:var(--surface-2,#f5f6f9);color:var(--text,#1d1c1d);cursor:pointer}',
    '.sess-btn.primary{background:var(--accent,#4f46e5);border-color:var(--accent,#4f46e5);color:#fff}',
    '.sess-btn.primary:hover{background:var(--accent-hover,#4338ca)}',
    '.sess-key{width:100%;font:inherit;padding:10px 14px;border-radius:10px;text-align:center;',
    'border:1px solid var(--border,#e4e6ec);background:var(--bg,#f4f5f8);color:var(--text,#1d1c1d);',
    'margin-bottom:14px;display:none}',
    '.sess-key.show{display:block}',
    '.sess-err{display:none;color:var(--danger,#dc2626);font-size:13px;margin:-8px 0 12px}',
    '.sess-err.show{display:block}',
    '.sess-out{margin-left:12px;font:inherit;font-size:13px;font-weight:600;padding:6px 12px;',
    'border-radius:8px;border:1px solid rgba(255,255,255,.25);background:transparent;',
    'color:rgba(255,255,255,.85);cursor:pointer}',
    '.sess-out:hover{background:rgba(255,255,255,.1)}'
  ].join('');
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ---------- popup ----------
  var overlay = el('div', 'sess-overlay');
  var card = el('div', 'sess-card');
  var logo = el('div', 'sess-logo', '🧰');
  var eyebrow = el('div', 'sess-eyebrow', 'KNAP Advisory · internal platform');
  var toolsStrip = el('div', 'sess-tools');
  [['🔁', 'GSTR-2B ⇄ Tally Poster'], ['🧮', 'TDS × 26AS Reconciler'], ['🔍', 'Tally Audit Assistant'],
   ['🧾', 'Marketplace Invoice Parser'], ['📊', 'GSTR-1 Excel Summary'], ['📒', 'AR Dashboard']]
    .forEach(function (t) { var s = el('span', '', t[0]); s.title = t[1]; toolsStrip.appendChild(s); });
  var h = el('h2', '', 'Your session is about to end');
  var p = el('p', '', 'Continue working, or sign out? Continuing keeps everything on this page exactly as it is.');
  var count = el('div', 'sess-count', '');
  var keyInput = document.createElement('input');
  keyInput.type = 'password'; keyInput.placeholder = 'Access key'; keyInput.className = 'sess-key';
  keyInput.autocomplete = 'current-password';
  var err = el('div', 'sess-err', 'That key is not right — try again.');
  var row = el('div', 'sess-row');
  var btnGo = el('button', 'sess-btn primary', 'Continue');
  var btnOut = el('button', 'sess-btn', 'Sign out & close');
  row.appendChild(btnGo); row.appendChild(btnOut);
  card.appendChild(logo); card.appendChild(eyebrow);
  card.appendChild(h); card.appendChild(p); card.appendChild(toolsStrip); card.appendChild(count);
  card.appendChild(keyInput); card.appendChild(err); card.appendChild(row);
  overlay.appendChild(card);

  var expired = false;

  function fmt(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }

  function toExpiredMode() {
    expired = true;
    h.textContent = 'Session expired';
    p.textContent = 'Enter the access key to continue right where you left off.';
    count.style.display = 'none';
    keyInput.classList.add('show');
    keyInput.focus();
  }

  // Opaque key screen for a tab that is not signed in yet (new or reopened
  // tab): same key flow as expiry, but nothing on the page shows behind it.
  function toLockMode() {
    overlay.classList.add('lock', 'show');
    h.textContent = 'KNAP Tools';
    p.textContent = 'Enter the access key to continue in this tab.';
    expired = true;
    count.style.display = 'none';
    keyInput.classList.add('show');
    keyInput.focus();
  }

  function showWarning() {
    // Another tab may have extended the session meanwhile — check first.
    fetch('/api/auth/status').then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        if (s && s.exp && s.exp - Date.now() > WARN_BEFORE) { schedule(s.exp); return; }
        overlay.classList.add('show');
        count.textContent = fmt(exp - Date.now());
        tick = setInterval(function () {
          var left = exp - Date.now();
          count.textContent = fmt(left);
          if (left <= 0 && !expired) { clearInterval(tick); toExpiredMode(); }
        }, 250);
      });
  }

  function hidePopup() {
    overlay.classList.remove('show', 'lock');
    clearInterval(tick);
    expired = false;
    h.textContent = 'Your session is about to end';
    p.textContent = 'Continue working, or sign out? Continuing keeps everything on this page exactly as it is.';
    count.style.display = '';
    keyInput.classList.remove('show'); keyInput.value = '';
    err.classList.remove('show');
  }

  function schedule(newExp) {
    exp = newExp;
    clearTimeout(warnTimer); clearInterval(tick);
    var inMs = Math.max(0, exp - Date.now() - WARN_BEFORE);
    warnTimer = setTimeout(showWarning, inMs);
  }

  btnGo.onclick = function () {
    err.classList.remove('show');
    if (expired) {
      if (!keyInput.value) { keyInput.focus(); return; }
      fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: keyInput.value })
      }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (s) {
          if (!s) { err.classList.add('show'); keyInput.select(); return; }
          markTab(); hidePopup(); schedule(s.exp);
        });
    } else {
      fetch('/api/auth/extend', { method: 'POST' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (s) {
          if (!s || !s.exp) { toExpiredMode(); return; } // already lapsed server-side
          hidePopup(); schedule(s.exp);
        });
    }
  };
  keyInput.onkeydown = function (e) { if (e.key === 'Enter') btnGo.click(); };

  function signOut() {
    unmarkTab();
    fetch('/api/auth/logout', { method: 'POST' }).then(function () { location.href = '/'; });
  }
  btnOut.onclick = signOut;

  // ---------- boot ----------
  fetch('/api/auth/status').then(function (r) { return r.ok ? r.json() : null; })
    .then(function (s) {
      if (!s || !s.gated) return; // open site (or not signed in): no session UI
      document.body.appendChild(overlay);
      var head = document.querySelector('.site-head-inner');
      if (head) {
        var out = el('button', 'sess-out', 'Sign out');
        out.onclick = signOut;
        head.appendChild(out);
      }
      if (!tabOk()) { toLockMode(); return; } // new/reopened tab: key first
      if (s.exp) schedule(s.exp);
    })
    .catch(function () { /* network hiccup: no session UI */ });
})();
