/* ============================================================================
 * v2.js — the redesigned financial statements workflow, driven by /api/fin2.
 *
 * Nothing is computed here. Every figure comes from the server's shared
 * presentation model, so the screen and the exported workbook cannot disagree
 * (spec §15). The browser's job is to show it and to collect decisions.
 * ==========================================================================*/

const $ = (id) => document.getElementById(id);
const API = '/api/fin2';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const inr = (n) => (n == null || n === '' ? '' :
  (n < 0 ? '(' + Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ')'
         : n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })));

const S = { eng: null, payload: null, ledgers: null, maxStep: 1, tab: 'bs', heads: [] };

/* ---------- plumbing ---------------------------------------------------- */
async function api(path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const j = await r.json().catch(() => ({ ok: false, error: 'bad response' }));
  if (!j.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
const connBase = () => ($('connUrl').value || 'http://127.0.0.1:8797').replace(/\/+$/, '');
/** The connector's data routes are POST-only; GET them and they 404. */
async function connPost(path, body = {}) {
  const r = await fetch(connBase() + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('connector HTTP ' + r.status + ' on ' + path);
  return r.json();
}
async function connGet(path) {
  const r = await fetch(connBase() + path);
  if (!r.ok) throw new Error('connector HTTP ' + r.status + ' on ' + path);
  return r.json();
}
/** Tally appends " - (from …)" to a company name; strip it for display. */
const cleanCoName = (n) => String(n || '').replace(/\s*-\s*\(from[^)]*\)\s*$/i, '').trim();
function msg(el, text, kind) {
  const c = kind === 'bad' ? 'var(--bad)' : kind === 'ok' ? 'var(--ok)' : 'var(--mut)';
  $(el).innerHTML = `<span style="color:${c}">${esc(text)}</span>`;
}

/* ---------- stepper ----------------------------------------------------- */
function go(n) {
  if (n > S.maxStep) return;
  for (let i = 1; i <= 6; i++) $('s' + i).classList.toggle('hidden', i !== n);
  document.querySelectorAll('#stepper .step').forEach((el) => {
    const st = +el.dataset.step;
    el.classList.toggle('active', st === n);
    el.classList.toggle('done', st < n);
    el.classList.toggle('clk', st <= S.maxStep && st !== n);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
const reach = (n) => { if (n > S.maxStep) S.maxStep = n; };
document.querySelectorAll('#stepper .step').forEach((el) =>
  el.addEventListener('click', () => go(+el.dataset.step)));

/* ---------- 1. engagement ---------------------------------------------- */
async function loadEngagements() {
  try {
    const { engagements } = await api('/engagements');
    // Only offer the "continue" picker once there is something to continue.
    $('engExisting').classList.toggle('hidden', engagements.length === 0);
    $('engFirst').classList.toggle('hidden', engagements.length > 0);
    $('engList').innerHTML = engagements.map((e) =>
      `<option value="${e.id}">${esc(e.client_name)} — FY ${esc(e.fy_start)} to ${esc(e.fy_end)} (${e.division})</option>`).join('');
  } catch (e) { msg('m1', 'Could not reach the server: ' + e.message, 'bad'); }
}
async function openEngagement(id) {
  const { engagements } = await api('/engagements');
  S.eng = engagements.find((e) => e.id === id);
  if (!S.eng) return;
  $('engPill').textContent = S.eng.client_name + ' · FY ' + S.eng.fy_end.slice(0, 4);
  $('pFrom').value = S.eng.fy_start; $('pTo').value = S.eng.fy_end;
  reach(2); go(2);
  try { await refresh(); } catch { /* no snapshot yet — expected */ }
}
$('engNew').onclick = async () => {
  try {
    const { id } = await api('/engagements', { method: 'POST', body: JSON.stringify({
      clientName: $('cName').value.trim(), cin: $('cCin').value.trim(),
      fyStart: $('cStart').value, fyEnd: $('cEnd').value, division: $('cDiv').value }) });
    msg('m1', 'Engagement created.', 'ok');
    await loadEngagements(); $('engList').value = id; await openEngagement(id);
  } catch (e) { msg('m1', e.message, 'bad'); }
};
$('engOpen').onclick = () => { const v = $('engList').value; if (v) openEngagement(v); };

/* ---------- 2. import from Tally --------------------------------------- */
$('coScan').onclick = async () => {
  msg('m2', 'Scanning Tally…');
  try {
    const j = await connPost('/api/dc/companies', {});
    // shape: { endpoints: [ { companies: [ "Name" | {name, gstins[]} ] } ] }
    const list = [];
    for (const ep of j.endpoints || []) {
      for (const c of ep.companies || []) {
        list.push({ name: typeof c === 'string' ? c : c.name,
                    gstin: typeof c === 'string' ? '' : ((c.gstins || [])[0] || '') });
      }
    }
    if (!list.length) {
      $('coList').innerHTML = '<option value="">— no company open —</option>';
      return msg('m2', 'No company is open in Tally. Open one on the Gateway of Tally, then scan again.', 'bad');
    }
    $('coList').innerHTML = list.map((c) =>
      `<option value="${esc(c.name)}">${esc(cleanCoName(c.name))}${c.gstin ? ' · ' + esc(c.gstin) : ''}</option>`).join('');
    msg('m2', list.length === 1 ? '1 company open.' : `${list.length} companies open — pick one.`, 'ok');
    await detectCompany();
  } catch (e) {
    msg('m2', 'Could not reach the connector (' + e.message + '). Is the KNAP Tally connector running on this PC, and is Tally open?', 'bad');
  }
};

/** Ask the connector about the picked company so the period fills itself in. */
async function detectCompany() {
  const co = $('coList').value;
  try {
    const c = await connGet('/api/fin/company' + (co ? '?company=' + encodeURIComponent(co) : ''));
    if (!c || !c.ok) return;
    if (c.start) $('pFrom').value = c.start;
    const end = c.lastVoucher || c.endingAt;
    if (end) $('pTo').value = end;
    msg('m2', `${cleanCoName(c.name) || 'Company'} · books from ${c.start || '?'} to ${end || '?'}. Adjust the period if you need to, then read the trial balance.`, 'ok');
  } catch { /* period stays as the engagement's FY — not fatal */ }
}
$('coList').onchange = detectCompany;
$('pull').onclick = async () => {
  if (!S.eng) return;
  msg('m2', 'Reading the trial balance from Tally…');
  try {
    const tb = await connPost('/api/fin/trialbalance', {
      from: $('pFrom').value, to: $('pTo').value, company: $('coList').value || '' });
    if (tb.ok === false) throw new Error(tb.error || 'Tally refused the request — is the company open?');
    const ledgers = (tb.ledgers || []).map((l) => ({
      name: l.name, group: l.group, primary: l.primary, groupPath: l.groupPath || [],
      gstin: l.gstin || '', isRevenue: !!l.isRevenue, current: l.current || 0, prior: l.prior || 0 }));
    if (!ledgers.length) throw new Error('no ledgers returned');
    const snap = await api(`/engagements/${S.eng.id}/snapshots`, { method: 'POST', body: JSON.stringify({
      source: 'tally', method: 'live', company: $('coList').value || '',
      periodFrom: $('pFrom').value, periodTo: $('pTo').value, ledgers }) });
    $('k2').innerHTML =
      kpi(snap.ledgerCount, 'ledgers sealed into the snapshot') +
      kpi(inr(snap.controlTotals.current), 'trial balance total (must be nil)', snap.balanced ? 'good' : 'bad');
    msg('m2', snap.balanced ? 'Snapshot sealed and the books balance.' : snap.warning, snap.balanced ? 'ok' : 'bad');
    await refresh(); reach(3); go(3);
  } catch (e) { msg('m2', 'Import failed: ' + e.message, 'bad'); }
};
const kpi = (v, t, cls = '') => `<div class="k ${cls}"><div class="v">${esc(v)}</div><div class="t">${esc(t)}</div></div>`;

/* ---------- refresh the whole model ------------------------------------ */
async function refresh() {
  const j = await api(`/engagements/${S.eng.id}/statements`);
  S.payload = j;
  S.heads = collectHeads(j);
  renderGrouping(); renderStatements(); renderChecks(); renderExport();
  reach(4);
}
function collectHeads(j) {
  const seen = new Map();
  for (const r of j.trialBalance) if (r.lineId) seen.set(r.lineId, r.lineCaption);
  for (const n of j.notes) seen.set(n.lineId, n.caption);
  for (const sec of [...j.balanceSheet.equityAndLiabilities, ...j.balanceSheet.assets])
    for (const r of sec.rows) seen.set(r.lineId, r.caption);
  return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
}

/* ---------- 3. grouping ------------------------------------------------- */
function renderGrouping() {
  const j = S.payload; if (!j) return;
  const filter = $('gFilter').value, q = $('gSearch').value.trim().toLowerCase();
  const needsReview = new Set(j.checks.filter((c) => c.id.startsWith('MAP-') || c.id.startsWith('RCL-'))
    .map((c) => c.message.replace(/^"/, '').split('"')[0]));
  const rows = j.trialBalance.filter((r) => {
    if (q && !r.ledger.toLowerCase().includes(q)) return false;
    if (filter === 'uncl') return r.lineId === 'unclassified';
    if (filter === 'review') return r.lineId === 'unclassified' || needsReview.has(r.ledger);
    return true;
  });
  const opts = (sel) => S.heads.map(([id, cap]) =>
    `<option value="${esc(id)}"${id === sel ? ' selected' : ''}>${esc(cap)}</option>`).join('');
  $('gRows').innerHTML = rows.length ? rows.map((r) => `
    <tr${r.lineId === 'unclassified' ? ' style="background:var(--bad-soft)"' : ''}>
      <td>${esc(r.ledger)}</td>
      <td class="muted">${esc(r.group || '')}</td>
      <td class="r">${inr(r.current)} <span class="muted">${r.drcr}</span></td>
      <td><select class="assign" data-led="${esc(r.ledger)}">${opts(r.lineId)}</select></td>
      <td class="muted">${esc((j.notes.find((n) => n.lineId === r.lineId) || {}).caption || '')}</td>
    </tr>`).join('')
    : '<tr><td colspan="5" class="muted">Nothing to review under this filter.</td></tr>';
  $('m3').textContent = `${rows.length} shown of ${j.trialBalance.length} ledgers.`;
}
$('gFilter').onchange = renderGrouping;
$('gSearch').oninput = renderGrouping;
$('gSave').onclick = async () => {
  const mappings = [...document.querySelectorAll('#gRows select.assign')].map((s) => ({
    ledgerKey: s.dataset.led, lineId: s.value, approved: true, confidence: 'manual',
    reason: 'reviewer approved' }));
  try {
    await api(`/engagements/${S.eng.id}/mappings`, { method: 'POST', body: JSON.stringify({ mappings }) });
    await refresh();
    msg('m3', `${mappings.length} mapping(s) approved and the statements rebuilt.`, 'ok');
    go(4);
  } catch (e) { msg('m3', e.message, 'bad'); }
};

/* ---------- 4. statements ---------------------------------------------- */
document.querySelectorAll('#stTabs button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('#stTabs button').forEach((x) => x.classList.toggle('on', x === b));
  S.tab = b.dataset.t; renderStatements();
});
function amtCols(o) { return `<td class="r">${inr(o.current)}</td><td class="r">${inr(o.prior)}</td>`; }
function head(t1, t2) {
  return `<table class="fin"><thead><tr><th>Particulars</th><th class="note">Note</th>
    <th class="r">${esc(t1)}</th><th class="r">${esc(t2)}</th></tr></thead><tbody>`;
}
function renderStatements() {
  const j = S.payload; if (!j) return;
  const m = j.meta, c = `As at ${m.currentLabel}`, p = `As at ${m.priorLabel}`;
  const crit = j.checks.filter((x) => x.severity === 'CRITICAL');
  $('stBanner').innerHTML = crit.length
    ? `<div class="banner bad">DRAFT — NOT FOR ISSUE · ${crit.length} unresolved critical exception(s). See step 5.</div>`
    : `<div class="banner ok">Arithmetic checks pass. Disclosures still need review before issue.</div>`;

  let h = '';
  if (S.tab === 'bs') {
    h = head(c, p);
    const sec = (s) => {
      let x = `<tr class="sec"><td colspan="4">${esc(s.title)}</td></tr>`;
      for (const r of s.rows) x += `<tr><td>${esc(r.caption)}</td><td class="note">${r.note || ''}</td>${amtCols(r)}</tr>`;
      return x;
    };
    h += '<tr class="grp"><td colspan="4">EQUITY AND LIABILITIES</td></tr>';
    j.balanceSheet.equityAndLiabilities.forEach((s) => { h += sec(s); });
    h += `<tr class="grp"><td>Total equity and liabilities</td><td></td>${amtCols(j.balanceSheet.totalEquityAndLiabilities)}</tr>`;
    h += '<tr class="grp"><td colspan="4">ASSETS</td></tr>';
    j.balanceSheet.assets.forEach((s) => { h += sec(s); });
    h += `<tr class="grp"><td>Total assets</td><td></td>${amtCols(j.balanceSheet.totalAssets)}</tr>`;
    const d = j.balanceSheet.difference;
    if (d.current || d.prior) {
      h += `<tr class="grp" style="color:var(--bad)"><td>Difference (assets − equity and liabilities)</td><td></td>${amtCols(d)}</tr>`;
      h += `<tr><td colspan="4" class="muted">This must be nil. It equals the trial-balance imbalance less any unclassified balance — resolve in step 3.</td></tr>`;
    }
    h += '</tbody></table>';
  } else if (S.tab === 'pl') {
    h = head(`Year ended ${m.currentLabel}`, `Year ended ${m.priorLabel}`);
    const line = (r) => `<tr><td>${esc(r.caption)}</td><td class="note">${r.note || ''}</td>${amtCols(r)}</tr>`;
    j.profitAndLoss.income.forEach((r) => { h += line(r); });
    h += `<tr class="grp"><td>Total income</td><td></td>${amtCols(j.profitAndLoss.totalIncome)}</tr>`;
    j.profitAndLoss.expenses.forEach((r) => { h += line(r); });
    h += `<tr class="grp"><td>Total expenses</td><td></td>${amtCols(j.profitAndLoss.totalExpenses)}</tr>`;
    if (j.profitAndLoss.pbtBefore) { h += `<tr class="grp"><td>${esc(j.profitAndLoss.pbtBefore.caption)}</td><td></td>${amtCols(j.profitAndLoss.pbtBefore)}</tr>`; h += line(j.profitAndLoss.exceptional); }
    h += `<tr class="grp"><td>Profit before tax</td><td></td>${amtCols(j.profitAndLoss.pbt)}</tr>`;
    j.profitAndLoss.taxRows.forEach((r) => { h += line(r); });
    h += `<tr class="grp"><td>Profit for the year</td><td></td>${amtCols(j.profitAndLoss.pat)}</tr>`;
    if (!j.profitAndLoss.taxRows.length) h += `<tr><td colspan="4" class="muted">No tax has been provided. If tax is due, post it as an adjusting journal so the charge reaches the profit and loss <b>and</b> the liability reaches the balance sheet.</td></tr>`;
    h += '</tbody></table>';
  } else if (S.tab === 'cf') {
    const cf = j.cashFlow;
    h = `<table class="fin"><thead><tr><th>Particulars</th><th class="r">Year ended ${esc(m.currentLabel)}</th></tr></thead><tbody>`;
    const r1 = (l, v, cls = '') => `<tr class="${cls}"><td>${esc(l)}</td><td class="r">${inr(v)}</td></tr>`;
    h += '<tr class="grp"><td colspan="2">A. Cash flow from operating activities</td></tr>';
    h += r1('Profit before tax', cf.operating.pbt);
    cf.operating.adjustments.forEach((a) => { h += r1('  ' + a.label, a.amount); });
    h += r1('Operating profit before working capital changes', cf.operating.operatingProfitBeforeWC, 'grp');
    cf.operating.workingCapital.forEach((w) => { h += r1('  ' + w.label, w.amount); });
    h += r1('Cash generated from operations', cf.operating.cashGenerated, 'grp');
    h += r1('Direct taxes paid', -cf.operating.taxPaid);
    h += r1('Net cash from operating activities', cf.operating.net, 'grp');
    h += '<tr class="grp"><td colspan="2">B. Cash flow from investing activities</td></tr>';
    cf.investing.items.forEach((i) => { h += r1('  ' + i.label, i.amount); });
    h += r1('Net cash from investing activities', cf.investing.net, 'grp');
    h += '<tr class="grp"><td colspan="2">C. Cash flow from financing activities</td></tr>';
    cf.financing.items.forEach((i) => { h += r1('  ' + i.label, i.amount); });
    h += r1('Net cash from financing activities', cf.financing.net, 'grp');
    h += r1('Net increase / (decrease) in cash', cf.netChange, 'grp');
    h += r1('Cash at the beginning of the year', cf.openingCash);
    h += r1('Cash at the end of the year (per the balance sheet)', cf.closingCashPerBS, 'grp');
    if (!cf.reconciled) h += `<tr class="grp" style="color:var(--bad)"><td>Unreconciled difference</td><td class="r">${inr(cf.unreconciled)}</td></tr>`;
    h += '</tbody></table>';
    if (cf.assumptions.length) h += '<div style="padding:10px 12px">' + cf.assumptions.map((a) =>
      `<div class="chk REVIEW"><b>Assumption ${esc(a.id)}</b> — ${esc(a.text)}</div>`).join('') + '</div>';
  } else {
    h = '';
    for (const n of j.notes) {
      h += `<table class="fin" style="margin-bottom:14px"><thead><tr>
        <th>Note ${n.number} — ${esc(n.caption)}</th><th class="r">${esc(m.currentLabel)}</th><th class="r">${esc(m.priorLabel)}</th></tr></thead><tbody>`;
      for (const s of n.subLines) h += `<tr><td>${esc(s.name)}</td><td class="r">${inr(s.current)}</td><td class="r">${inr(s.prior)}</td></tr>`;
      h += `<tr class="grp"><td>Total</td><td class="r">${inr(n.current)}</td><td class="r">${inr(n.prior)}</td></tr>`;
      if (n.requires.length) h += `<tr><td colspan="3" class="muted">Still required: ${n.requires.map(esc).join(' · ')}</td></tr>`;
      h += '</tbody></table>';
    }
    if (!j.notes.length) h = '<p class="muted" style="padding:12px">No notes yet.</p>';
  }
  $('stBody').innerHTML = h;
}

/* ---------- 5. exceptions ---------------------------------------------- */
function renderChecks() {
  const j = S.payload; if (!j) return;
  const order = { CRITICAL: 0, HIGH: 1, REVIEW: 2, INFO: 3 };
  const cs = j.checks.slice().sort((a, b) => order[a.severity] - order[b.severity]);
  $('chkList').innerHTML = cs.length ? cs.map((c) =>
    `<div class="chk ${c.severity}"><b>${c.severity}</b> · ${esc(c.message)}${c.amount != null ? ` <span class="muted">(${inr(c.amount)})</span>` : ''}</div>`).join('')
    : '<div class="chk INFO">No exceptions.</div>';
  $('discRows').innerHTML = j.disclosures.length ? j.disclosures.map((d) =>
    `<tr><td class="note">${d.note || ''}</td><td>${esc(d.caption)}</td><td>${esc(d.requirement)}</td>
     <td><span class="pill warn">${esc(d.status)}</span></td></tr>`).join('')
    : '<tr><td colspan="4" class="muted">Nothing outstanding.</td></tr>';
  reach(5);
}

/* ---------- 6. export --------------------------------------------------- */
function renderExport() {
  const j = S.payload; if (!j) return;
  const crit = j.checks.filter((c) => c.severity === 'CRITICAL');
  $('exBanner').innerHTML = crit.length
    ? `<div class="banner bad">${crit.length} critical exception(s) outstanding — the workbook will be watermarked DRAFT — NOT FOR ISSUE and cannot be marked Final.</div>`
    : `<div class="banner ok">No critical exceptions. The workbook may be issued as a reviewed draft.</div>`;
  reach(6);
}
$('exXlsx').onclick = async () => {
  if (!S.payload) return;
  msg('m6', 'Building the workbook…');
  try {
    const mod = await import('./export/workbook.js');
    if (!window.ExcelJS) throw new Error('the Excel library is still loading — try again in a moment');
    const wb = mod.buildWorkbook(window.ExcelJS, S.payload);
    const buf = await wb.xlsx.writeBuffer();
    const name = (S.payload.meta.entity || 'Financials').replace(/[^A-Za-z0-9]+/g, '_')
      + '_ScheduleIII_' + (S.payload.meta.currentLabel || '').replace(/\s+/g, '_') + '.xlsx';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 1500);
    msg('m6', 'Workbook downloaded.', 'ok');
  } catch (e) { msg('m6', 'Export failed: ' + e.message, 'bad'); }
};
$('exFinal').onclick = async () => {
  try {
    const j = await api(`/engagements/${S.eng.id}/release`, { method: 'POST', body: JSON.stringify({ status: 'reviewed' }) });
    msg('m6', 'Recorded as ' + j.status + ' (version ' + j.reportVersionId + ').', 'ok');
  } catch (e) { msg('m6', e.message, 'bad'); }
};

/* ---------- boot -------------------------------------------------------- */
loadEngagements();
