/* ============================================================================
 * KNAP — GSTR-2B / 2A capture, run inside your own GST portal tab.
 *
 * WHAT IT IS.  You are logged in. You click Download once, the normal way. This
 * watches what the portal does to serve that one click, then repeats exactly
 * that for the other months you pick, and hands you a ZIP to drop into the ITC
 * reconciliation tool.
 *
 * WHAT IT IS NOT.  It does not know anything about GSTN's API, does not log in,
 * and never sees a username, a password or an OTP. It has no server of its own:
 * nothing is sent anywhere, and closing the tab is all the cleanup there is.
 *
 * WHY RECORD RATHER THAN HARD-CODE.  The portal's internal endpoints are not
 * published and not promised. A script that had them written into it would work
 * until the morning it silently didn't. This one learns them from your own
 * click every time it runs, so the day GSTN changes something, the recording
 * changes with it.
 *
 * It is still automation of a site that does not invite it. Keep the pacing
 * slow, do not leave it running, and if the portal starts refusing, stop.
 * ==========================================================================*/
(function () {
  'use strict';

  if (!/(^|\.)gst\.gov\.in$/i.test(location.hostname)) {
    alert('Run this in the GST portal tab (services.gst.gov.in), on the Returns page.');
    return;
  }
  if (window.__KNAP_CAP__) { window.__KNAP_CAP__.show(); return; }

  var MAX_PERIODS = 24;          // a financial year is 12; two, with the spill months
  var MIN_GAP_MS = 1500;         // never faster than this, whatever the box says
  var POLL_TRIES = 20;           // the portal generates the file, then serves it
  var POLL_GAP_MS = 3000;

  var _fetch = window.fetch ? window.fetch.bind(window) : null;
  var CALLS = [];                // what the portal did, in order
  var recording = false;
  var busy = false;

  /* ---------------------------------------------------------------- watching */

  function interesting(u) {
    var s = String(u || '');
    if (!s) return false;
    if (/\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|eot|ico|html?)(\?|#|$)/i.test(s)) return false;
    if (/^(data|blob):/i.test(s)) return false;
    if (/^https?:\/\//i.test(s) && s.indexOf(location.origin) !== 0) return false;
    return true;
  }
  function headerObj(h) {
    var o = {};
    if (!h) return o;
    if (typeof h.forEach === 'function' && !Array.isArray(h)) { h.forEach(function (v, k) { o[k] = v; }); return o; }
    if (Array.isArray(h)) { h.forEach(function (p) { o[p[0]] = p[1]; }); return o; }
    Object.keys(h).forEach(function (k) { o[k] = h[k]; });
    return o;
  }
  function note(c) {
    if (!recording) return;
    CALLS.push(c);
    render();
  }

  if (_fetch) {
    window.fetch = function (input, init) {
      var url = (typeof input === 'string') ? input : (input && input.url) || '';
      var method = (init && init.method) || (input && input.method) || 'GET';
      var headers = headerObj((init && init.headers) || (input && input.headers));
      var body = (init && init.body) || null;
      var p = _fetch(input, init);
      if (recording && interesting(url)) {
        p.then(function (r) {
          try {
            r.clone().text().then(function (t) {
              note({ method: method, url: abs(url), headers: headers, body: typeof body === 'string' ? body : null,
                     status: r.status, text: t });
            }, function () {});
          } catch (e) { /* an already-consumed body is not worth a failure */ }
        }, function () {});
      }
      return p;
    };
  }

  var XO = XMLHttpRequest.prototype.open,
      XS = XMLHttpRequest.prototype.send,
      XH = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__kn = { method: m, url: u, headers: {} };
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__kn) this.__kn.headers[k] = v;
    return XH.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (b) {
    var self = this;
    if (this.__kn) {
      this.__kn.body = (typeof b === 'string') ? b : null;
      this.addEventListener('load', function () {
        if (!interesting(self.__kn.url)) return;
        var t = '';
        try { t = (self.responseType === '' || self.responseType === 'text') ? self.responseText : ''; } catch (e) {}
        note({ method: self.__kn.method, url: abs(self.__kn.url), headers: self.__kn.headers,
               body: self.__kn.body, status: self.status, text: t });
      });
    }
    return XS.apply(this, arguments);
  };

  function abs(u) { try { return new URL(u, location.href).href; } catch (e) { return String(u); } }

  /* ------------------------------------------------- which month was that? */

  var PERIOD_RE = /\b(0[1-9]|1[0-2])(20\d{2})\b/;
  /* A return period is MMYYYY. Prefer one that sits under a name the portal
     itself used — a bare six digits could be anything. */
  function periodOf(call) {
    var s = call.url + ' ' + (call.body || '');
    var m = s.match(/(?:rtnprd|ret_period|retperiod|returnperiod|period|fp)["'\s:=\]]*[=:]?["'\s]*(\d{6})/i);
    if (m && /^(0[1-9]|1[0-2])20\d{2}$/.test(m[1])) return m[1];
    var g = s.match(PERIOD_RE);
    return g ? g[0] : '';
  }
  function recordedPeriod() {
    for (var i = CALLS.length - 1; i >= 0; i--) { var p = periodOf(CALLS[i]); if (p) return p; }
    return '';
  }
  function gstinSeen() {
    for (var i = 0; i < CALLS.length; i++) {
      var m = (CALLS[i].url + ' ' + (CALLS[i].body || '')).match(/\b(\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9])\b/);
      if (m) return m[1];
    }
    return '';
  }
  function monthName(p) {
    var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return M[Number(p.slice(0, 2)) - 1] + '-' + p.slice(4);
  }
  /* The twelve returns of the financial year the recorded month belongs to,
     plus the April and May after it, where that year's late filings land. */
  function yearOf(p) {
    var mm = Number(p.slice(0, 2)), yy = Number(p.slice(2)), fy = mm >= 4 ? yy : yy - 1, out = [];
    for (var i = 0; i < 14; i++) {
      var m = 4 + i, y = fy + Math.floor((m - 1) / 12);
      m = ((m - 1) % 12) + 1;
      out.push((m < 10 ? '0' : '') + m + y);
    }
    return out;
  }

  /* ------------------------------------------------------------- replaying */

  function sub(s, from, to) { return s == null ? s : String(s).split(from).join(to); }
  function exec(call) {
    var opt = { method: call.method || 'GET', credentials: 'include', headers: {} };
    Object.keys(call.headers || {}).forEach(function (k) {
      if (/^(cookie|host|content-length|connection|user-agent)$/i.test(k)) return;  // the browser owns these
      opt.headers[k] = call.headers[k];
    });
    if (call.body != null && !/^(GET|HEAD)$/i.test(opt.method)) opt.body = call.body;
    return _fetch(call.url, opt).then(function (r) {
      return r.arrayBuffer().then(function (b) { return { status: r.status, buf: b }; });
    });
  }

  function utf8(buf) { try { return new TextDecoder('utf-8').decode(new Uint8Array(buf)); } catch (e) { return ''; } }
  function isZip(u8) { return u8.length > 3 && u8[0] === 0x50 && u8[1] === 0x4B; }
  function b64bytes(s) {
    try {
      var bin = atob(s), u = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u;
    } catch (e) { return null; }
  }
  /* Is this the return itself? The same shapes the reconciliation tool reads:
     2B keeps its tables under data.docdata, 2A puts b2b / cdn at the top. */
  function returnShape(j) {
    var t = (j && j.data) ? j.data : j;
    if (!t || typeof t !== 'object') return false;
    /* `rtnprd` alone is NOT enough, though it reads like it should be. The
       portal echoes the return period back in its "still generating" reply, so
       taking that as the answer would save a status message as the month's
       return and report the year short. Only the document tables count. */
    if (t.docdata && typeof t.docdata === 'object') return true;
    var d = t.docdata || t;
    return !!(d.b2b || d.b2ba || d.cdn || d.cdna || d.cdnr || d.cdnra || d.impg || d.isd);
  }
  /* What came back, if it is worth keeping: the return as JSON, or a ZIP the
     portal wrapped it in — sometimes raw, sometimes base64 inside JSON. */
  function payloadOf(res) {
    var u8 = new Uint8Array(res.buf);
    if (isZip(u8)) return { kind: 'zip', bytes: u8 };
    var text = utf8(res.buf);
    if (!text) return null;
    var j;
    try { j = JSON.parse(text); } catch (e) { return null; }
    if (returnShape(j)) return { kind: 'json', text: text };
    var found = null;
    Object.keys(j || {}).forEach(function (k) {
      if (found || typeof j[k] !== 'string' || j[k].length < 64) return;
      var b = b64bytes(j[k]);
      if (b && isZip(b)) found = { kind: 'zip', bytes: b };
    });
    return found;
  }

  /* One month: replay the recorded sequence with the period swapped, then keep
     asking the last call until the portal has finished generating the file. */
  function fetchPeriod(from, to, gapMs, say) {
    var seq = CALLS.map(function (c) {
      return { method: c.method, url: sub(c.url, from, to), headers: c.headers, body: sub(c.body, from, to) };
    });
    var got = null, i = 0;
    function step() {
      if (got || i >= seq.length) return poll(0);
      var c = seq[i++];
      return exec(c).then(function (res) {
        var p = payloadOf(res);
        if (p) got = p;
        return wait(gapMs).then(step);
      }, function () { return wait(gapMs).then(step); });
    }
    function poll(n) {
      if (got) return got;
      if (n >= POLL_TRIES || !seq.length) return null;
      say(monthName(to) + ' — waiting for the portal to generate it (' + (n + 1) + ')');
      return wait(POLL_GAP_MS).then(function () {
        return exec(seq[seq.length - 1]).then(function (res) {
          var p = payloadOf(res);
          if (p) { got = p; return got; }
          return poll(n + 1);
        }, function () { return poll(n + 1); });
      });
    }
    return step();
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ------------------------------------------------- writing the ZIP by hand
     No library: the portal's own page is not ours to load scripts into. Stored,
     not deflated — these are JSON files going straight back out of the browser,
     and a ZIP nobody can open is worse than a big one. */
  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function zipOf(files) {
    var enc = new TextEncoder(), parts = [], central = [], off = 0;
    function u16(n) { return [n & 0xFF, (n >>> 8) & 0xFF]; }
    function u32(n) { return [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]; }
    files.forEach(function (f) {
      var name = enc.encode(f.name), data = f.bytes, c = crc32(data);
      var lh = [].concat([0x50, 0x4B, 0x03, 0x04], u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(c), u32(data.length), u32(data.length), u16(name.length), u16(0));
      parts.push(new Uint8Array(lh), name, data);
      central.push({ name: name, crc: c, size: data.length, off: off });
      off += lh.length + name.length + data.length;
    });
    var cd = [], cdLen = 0;
    central.forEach(function (e) {
      var h = [].concat([0x50, 0x4B, 0x01, 0x02], u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(e.crc), u32(e.size), u32(e.size), u16(e.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(e.off));
      cd.push(new Uint8Array(h), e.name);
      cdLen += h.length + e.name.length;
    });
    var eo = [].concat([0x50, 0x4B, 0x05, 0x06], u16(0), u16(0), u16(central.length), u16(central.length),
      u32(cdLen), u32(off), u16(0));
    var all = parts.concat(cd, [new Uint8Array(eo)]);
    var total = all.reduce(function (n, a) { return n + a.length; }, 0);
    var out = new Uint8Array(total), at = 0;
    all.forEach(function (a) { out.set(a, at); at += a.length; });
    return out;
  }
  function download(bytes, name) {
    var url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 4000);
  }

  /* -------------------------------------------------------------- the panel */

  var el = {};
  function css(n, s) { Object.keys(s).forEach(function (k) { n.style[k] = s[k]; }); }
  function mk(tag, style, text) {
    var n = document.createElement(tag);
    if (style) css(n, style);
    if (text != null) n.textContent = text;
    return n;
  }
  function build() {
    var p = mk('div', { position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483647,
      width: '360px', maxHeight: '78vh', overflow: 'auto', background: '#fff', color: '#111',
      border: '1px solid #bbb', borderRadius: '10px', boxShadow: '0 8px 30px rgba(0,0,0,.25)',
      font: '13px/1.45 system-ui,Segoe UI,Arial,sans-serif', padding: '12px 14px' });
    var h = mk('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' });
    h.appendChild(mk('b', null, 'KNAP · capture 2B / 2A'));
    var x = mk('span', { cursor: 'pointer', padding: '0 4px', color: '#666' }, '✕');
    x.onclick = function () { p.style.display = 'none'; };
    h.appendChild(x);
    p.appendChild(h);

    el.note = mk('div', { color: '#555', marginBottom: '8px' });
    el.note.innerHTML = 'Runs in your own session. Nothing is stored and nothing is sent anywhere — '
      + 'close this tab and it is gone.';
    p.appendChild(el.note);

    el.step1 = mk('div', { padding: '8px 10px', background: '#f6f6f6', borderRadius: '8px', marginBottom: '8px' });
    p.appendChild(el.step1);

    el.step2 = mk('div', { marginBottom: '8px' });
    p.appendChild(el.step2);

    el.log = mk('div', { color: '#444', whiteSpace: 'pre-wrap', maxHeight: '160px', overflow: 'auto' });
    p.appendChild(el.log);

    document.body.appendChild(p);
    el.panel = p;
  }
  function say(s) { el.log.textContent = s; }
  function addLog(s) { el.log.textContent += (el.log.textContent ? '\n' : '') + s; el.log.scrollTop = 1e6; }

  function render() {
    if (!el.panel) return;
    var per = recordedPeriod(), g = gstinSeen();
    el.step1.innerHTML = '';
    if (!recording) {
      el.step1.appendChild(mk('div', null, '1 · Press Start, then download ONE month the normal way.'));
      var b = mk('button', { marginTop: '6px', padding: '6px 12px', cursor: 'pointer' }, 'Start watching');
      b.onclick = function () { recording = true; CALLS = []; render(); };
      el.step1.appendChild(b);
      el.step2.innerHTML = '';
      return;
    }
    el.step1.appendChild(mk('div', null, '1 · Watching. Download ONE month the normal way.'));
    el.step1.appendChild(mk('div', { color: '#555' },
      CALLS.length + ' call' + (CALLS.length === 1 ? '' : 's') + ' seen'
      + (per ? ' · month ' + monthName(per) : '') + (g ? ' · ' + g : '')));
    var again = mk('button', { marginTop: '6px', padding: '4px 10px', cursor: 'pointer' }, 'Clear and watch again');
    again.onclick = function () { CALLS = []; say(''); render(); };
    el.step1.appendChild(again);

    el.step2.innerHTML = '';
    if (!per) {
      el.step2.appendChild(mk('div', { color: '#a00' },
        'No return period seen yet — download one month and this fills in.'));
      return;
    }
    el.step2.appendChild(mk('div', null, '2 · Which months? (' + monthName(per) + ' is the one recorded)'));
    var box = mk('div', { display: 'flex', flexWrap: 'wrap', gap: '4px', margin: '6px 0' });
    var want = {};
    yearOf(per).forEach(function (p) {
      var on = true;
      var t = mk('label', { display: 'inline-flex', alignItems: 'center', gap: '3px',
        border: '1px solid #ccc', borderRadius: '6px', padding: '2px 6px', cursor: 'pointer' });
      var c = document.createElement('input');
      c.type = 'checkbox'; c.checked = on; want[p] = on;
      c.onchange = function () { want[p] = c.checked; };
      t.appendChild(c); t.appendChild(mk('span', null, monthName(p)));
      box.appendChild(t);
    });
    el.step2.appendChild(box);

    var gapWrap = mk('div', { margin: '4px 0', color: '#555' });
    gapWrap.appendChild(mk('span', null, 'seconds between months: '));
    var gap = document.createElement('input');
    gap.type = 'number'; gap.value = '4'; gap.min = '2'; gap.style.width = '56px';
    gapWrap.appendChild(gap);
    el.step2.appendChild(gapWrap);

    var go = mk('button', { padding: '7px 14px', cursor: 'pointer', fontWeight: '600' }, 'Fetch and download ZIP');
    go.onclick = function () {
      if (busy) return;
      var list = Object.keys(want).filter(function (k) { return want[k]; }).sort(function (a, b) {
        return (a.slice(2) + a.slice(0, 2)) < (b.slice(2) + b.slice(0, 2)) ? -1 : 1;
      });
      if (!list.length) { say('Pick at least one month.'); return; }
      if (list.length > MAX_PERIODS) { say('That is more than ' + MAX_PERIODS + ' months.'); return; }
      run(per, list, Math.max(MIN_GAP_MS, (Number(gap.value) || 4) * 1000), g);
    };
    el.step2.appendChild(go);
  }

  function run(from, list, gapMs, gstin) {
    busy = true;
    var files = [], missed = [], i = 0;
    say('Fetching ' + list.length + ' month' + (list.length === 1 ? '' : 's') + ', '
        + (gapMs / 1000) + 's apart. Leave this tab open.');
    (function next() {
      if (i >= list.length) return finish();
      var p = list[i++];
      addLog(monthName(p) + ' …');
      Promise.resolve(p === from ? replayOrKeep(from, p, gapMs) : fetchPeriod(from, p, gapMs, say))
        .then(function (got) {
          if (!got) { missed.push(p); addLog('  nothing returned for ' + monthName(p)); }
          else {
            var base = (gstin ? gstin + '_' : '') + p;
            files.push(got.kind === 'zip'
              ? { name: base + '.zip', bytes: got.bytes }
              : { name: 'returns_' + base + '.json', bytes: new TextEncoder().encode(got.text) });
            addLog('  got ' + monthName(p) + ' (' + got.kind + ')');
          }
          return wait(gapMs);
        }, function (e) { missed.push(p); addLog('  failed ' + monthName(p) + ': ' + (e && e.message)); return wait(gapMs); })
        .then(next);
    })();

    function finish() {
      busy = false;
      if (!files.length) {
        addLog('\nNothing came back. The recording may not include the download itself — '
             + 'clear, press Start, and click the portal\'s own Download button once.');
        return;
      }
      download(zipOf(files), 'GSTR_' + (gstin || 'portal') + '_' + list[0] + '-' + list[list.length - 1] + '.zip');
      addLog('\n' + files.length + ' file' + (files.length === 1 ? '' : 's') + ' in the ZIP'
           + (missed.length ? ', ' + missed.length + ' month(s) empty: ' + missed.map(monthName).join(', ') : '')
           + '.\nDrop it straight into the ITC reconciliation tool.');
    }
  }
  /* The month that was recorded is already in hand — but replaying it is the
     honest check that the replay works at all, so it is fetched like the rest. */
  function replayOrKeep(from, p, gapMs) { return fetchPeriod(from, p, gapMs, say); }

  window.__KNAP_CAP__ = {
    show: function () { if (el.panel) el.panel.style.display = ''; },
    calls: function () { return CALLS; },
    /* for the test harness */
    _internals: { periodOf: periodOf, yearOf: yearOf, payloadOf: payloadOf, zipOf: zipOf,
                  fetchPeriod: fetchPeriod, setCalls: function (c) { CALLS = c; recording = true; } },
  };
  build();
  render();
  say('Ready. Press Start, then download one month.');
})();
