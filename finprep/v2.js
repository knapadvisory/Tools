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

const S = { eng: null, payload: null, ledgers: null, maxStep: 1, tab: 'bs', heads: [], inputs: null, prior: null };

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
  for (let i = 1; i <= 8; i++) $('s' + i).classList.toggle('hidden', i !== n);
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
  if (S.eng.scale) $('scalePick').value = S.eng.scale;
  reach(3); go(2);
  await loadInputs();
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
    await refresh(); reach(4); go(4);
  } catch (e) { msg('m2', 'Import failed: ' + e.message, 'bad'); }
};
const kpi = (v, t, cls = '') => `<div class="k ${cls}"><div class="v">${esc(v)}</div><div class="t">${esc(t)}</div></div>`;

/* ---------- refresh the whole model ------------------------------------ */
async function refresh() {
  const j = await api(`/engagements/${S.eng.id}/statements`);
  S.payload = j;
  if (!S.heads.length) await loadHeads();
  renderGrouping(); renderStatements(); renderChecks(); renderExport();
  reach(5);
  renderObservations();
}
/**
 * The full Schedule III chart, from the server. It must NOT be derived from the
 * heads already in use, or a head could never be assigned for the first time.
 */
async function loadHeads() {
  const div = (S.eng && S.eng.division) || 'AS';
  const { lines } = await api('/lines?division=' + div);
  S.heads = lines;
}
/** <optgroup> markup, sections in Schedule III order, with the current pick selected. */
function headOptions(sel) {
  const order = ['EQUITY', 'NCL', 'CL', 'NCA', 'CA', 'INCOME', 'EXPENSE', 'TAX', 'OCI', 'UNCLASSIFIED'];
  const bySec = new Map();
  for (const l of S.heads) {
    if (!bySec.has(l.section)) bySec.set(l.section, { title: l.sectionTitle, items: [] });
    bySec.get(l.section).items.push(l);
  }
  let html = '';
  for (const sec of order) {
    const g = bySec.get(sec); if (!g) continue;
    html += `<optgroup label="${esc(g.title)}">` + g.items.map((l) =>
      `<option value="${esc(l.lineId)}"${l.lineId === sel ? ' selected' : ''}>${esc(l.caption)}</option>`).join('') + '</optgroup>';
  }
  return html;
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
  const opts = (sel) => headOptions(sel);
  $('gRows').innerHTML = rows.length ? rows.map((r) => `
    <tr${r.lineId === 'unclassified' ? ' style="background:var(--bad-soft)"' : ''}>
      <td>${esc(r.ledger)}</td>
      <td class="muted">${esc(r.group || '')}</td>
      <td class="r">${inr(r.current)} <span class="muted">${r.drcr}</span></td>
      <td><select class="assign" data-led="${esc(r.ledger)}">${opts(r.lineId)}</select></td>
      <td><input class="subg" data-led="${esc(r.ledger)}" value="${esc(r.subGroup || '')}"
           placeholder="(own line)" style="width:100%;font-size:12px" title="The caption this ledger appears under on the note. Ledgers sharing a caption are shown as one line."></td>
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
  // Only send a sub-group the preparer actually changed; a caption left as the
  // tool proposed it stays a proposal, so it keeps improving as rules improve.
  const subgroups = [...document.querySelectorAll('#gRows input.subg')]
    .filter((i) => i.value.trim() !== (i.defaultValue || '').trim())
    .map((i) => ({ ledgerKey: i.dataset.led, label: i.value.trim() }));
  try {
    await api(`/engagements/${S.eng.id}/mappings`, { method: 'POST', body: JSON.stringify({ mappings }) });
    if (subgroups.length) await api(`/engagements/${S.eng.id}/subgroups`, { method: 'POST', body: JSON.stringify({ subgroups }) });
    await refresh();
    msg('m3', `${mappings.length} mapping(s) approved and the statements rebuilt.`, 'ok');
    go(5);
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
      for (const s of n.subLines) {
        h += `<tr><td>${esc(s.name)}</td><td class="r">${inr(s.current)}</td><td class="r">${inr(s.prior)}</td></tr>`;
        // the ledgers behind an aggregated line, so the figure stays traceable
        if ((s.members || []).length > 1) h += `<tr><td colspan="3" class="muted" style="padding-left:22px">`
          + s.members.map((m) => `${esc(m.name)} ${inr(m.current)}`).join(' · ') + '</td></tr>';
      }
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
  reach(6);
}

/* ---------- 6. export --------------------------------------------------- */
function renderExport() {
  const j = S.payload; if (!j) return;
  const crit = j.checks.filter((c) => c.severity === 'CRITICAL');
  $('exBanner').innerHTML = crit.length
    ? `<div class="banner bad">${crit.length} critical exception(s) outstanding — the workbook will be watermarked DRAFT — NOT FOR ISSUE and cannot be marked Final.</div>`
    : `<div class="banner ok">No critical exceptions. The workbook may be issued as a reviewed draft.</div>`;
  reach(8);
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

/* ---------- 2. supporting documents ------------------------------------- */
const KIND_ICON = { prior_financials: '📄', gstr2b: '🧾', gstr1_3b: '📊', tds_conso: '🧮', other: '📎' };

async function loadInputs() {
  if (!S.eng) return;
  const j = await api(`/engagements/${S.eng.id}/inputs`);
  S.inputs = j;
  renderKinds(j); renderCoverage(j); renderInputRows(j);
}

function renderKinds(j) {
  $('inpKinds').innerHTML = j.kinds.map((k) => {
    const n = j.coverage.counts[k.kind] || 0;
    return `<div style="border:1px solid var(--rule);border-radius:10px;padding:12px 14px;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <b>${KIND_ICON[k.kind] || ''} ${esc(k.label)}</b>
        ${k.recommended ? '<span class="pill warn">recommended</span>' : ''}
        <span class="pill ${n ? 'ok' : 'bad'}">${n} file${n === 1 ? '' : 's'}</span>
        <span class="sp" style="margin-left:auto"></span>
        ${k.perPeriod ? `<input type="date" id="pf_${k.kind}" title="period from" style="font-size:12px">
           <input type="date" id="pt_${k.kind}" title="period to" style="font-size:12px">` : ''}
        <input type="file" id="f_${k.kind}" accept="${esc(k.accepts)}" ${k.multiple ? 'multiple' : ''} style="font-size:12px">
        <button class="btn sm" data-up="${k.kind}" type="button">Upload</button>
      </div>
      <div class="muted" style="margin-top:6px">${esc(k.purpose)}</div>
      ${k.withoutIt ? `<div class="muted" style="margin-top:3px"><b>Without it:</b> ${esc(k.withoutIt)}</div>` : ''}
      ${k.caution ? `<div class="chk REVIEW" style="margin-top:6px">${esc(k.caution)}</div>` : ''}
    </div>`;
  }).join('');
  $('inpKinds').querySelectorAll('[data-up]').forEach((b) => b.onclick = () => uploadKind(b.dataset.up));
}

async function uploadKind(kind) {
  const inp = $('f_' + kind);
  if (!inp || !inp.files.length) return alert('Choose a file first.');
  const fd = new FormData();
  fd.append('kind', kind);
  const pf = $('pf_' + kind), pt = $('pt_' + kind);
  if (pf && pf.value) fd.append('periodFrom', pf.value);
  if (pt && pt.value) fd.append('periodTo', pt.value || pf.value);
  for (const f of inp.files) fd.append('files', f);
  // last year's financials are also READ, not just stored
  if (kind === 'prior_financials') {
    $('priorPreview').innerHTML = '<p class="muted">Reading the document…</p>';
    try { renderPriorPreview(await extractPrior(inp.files[0])); }
    catch (e) { $('priorPreview').innerHTML = `<div class="chk CRITICAL">Could not read it: ${esc(e.message)}</div>`; }
  }
  try {
    const r = await fetch(API + `/engagements/${S.eng.id}/inputs`, { method: 'POST', body: fd });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error);
    const dup = j.files.filter((f) => f.status === 'duplicate');
    if (dup.length) alert(dup.map((d) => d.message).join('\n'));
    inp.value = '';
    await loadInputs();
  } catch (e) { alert('Upload failed: ' + e.message); }
}

function renderCoverage(j) {
  const per = j.coverage.perKind;
  const keys = Object.keys(per);
  if (!keys.length) return ($('inpCoverage').innerHTML = '<p class="muted">No period-based documents yet.</p>');
  $('inpCoverage').innerHTML = keys.map((k) => {
    const c = per[k];
    const cells = c.months.map((m) =>
      `<span title="${m.month}" style="display:inline-block;padding:3px 7px;margin:2px;border-radius:5px;font-size:11px;
        background:${m.present ? 'var(--soft)' : 'var(--bad-soft)'};color:${m.present ? 'var(--ok)' : 'var(--bad)'}">
        ${m.month.slice(5)}/${m.month.slice(2, 4)}</span>`).join('');
    return `<div style="margin-bottom:10px"><b>${esc(c.label)}</b>
      ${c.missing.length ? `<span class="pill bad">${c.missing.length} month(s) missing</span>`
                         : '<span class="pill ok">complete</span>'}
      <div style="margin-top:4px">${cells}</div>
      ${c.filesWithoutPeriod ? `<div class="muted">${c.filesWithoutPeriod} file(s) have no period recorded — coverage cannot count them.</div>` : ''}
    </div>`;
  }).join('');
}

function renderInputRows(j) {
  $('inpRows').innerHTML = j.files.length ? j.files.map((f) => `
    <tr><td>${esc((j.kinds.find((k) => k.kind === f.kind) || {}).label || f.kind)}</td>
      <td>${esc(f.filename)}</td>
      <td class="muted">${f.period_from ? esc(f.period_from) + ' → ' + esc(f.period_to || f.period_from) : '—'}</td>
      <td class="r">${(f.bytes / 1024).toFixed(0)} KB</td>
      <td class="muted" style="font-family:monospace;font-size:11px">${esc(String(f.sha256).slice(0, 12))}</td>
      <td><button class="btn ghost sm" data-del="${f.id}" type="button">Remove</button></td></tr>`).join('')
    : '<tr><td colspan="6" class="muted">Nothing uploaded yet. You can continue without these — step 7 will list what could not be checked.</td></tr>';
  $('inpRows').querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('Remove this document?')) return;
    await fetch(API + `/engagements/${S.eng.id}/inputs/${b.dataset.del}`, { method: 'DELETE' });
    await loadInputs();
  });
}
$('inpNext').onclick = () => { reach(3); go(3); };

/* ---------- read last year's signed financials -------------------------- */
/* Parsed HERE, in the browser, where the file already is. Nothing is applied
 * until the preparer confirms it — spec §4 requires value, source, confidence
 * and review status for every extracted field.                              */
async function extractPrior(file) {
  const buf = await file.arrayBuffer();
  const mod = await import('./core/priorImport.js');
  if (/\.pdf$/i.test(file.name)) {
    if (!window.pdfjsLib) {
      await new Promise((ok, err) => {
        const sc = document.createElement('script');
        sc.src = '/pdftools/pdf.min.js'; sc.onload = ok; sc.onerror = err;
        document.head.appendChild(sc);
      });
      if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdftools/pdf.worker.min.js';
    }
    return mod.readPdf(window.pdfjsLib, buf);
  }
  if (!window.ExcelJS) throw new Error('the Excel library is still loading — try again in a moment');
  return mod.readWorkbook(window.ExcelJS, buf, (S.eng && S.eng.division) || 'AS');
}

function renderPriorPreview(x) {
  S.prior = x;
  const f = x.fields || [], fig = x.figures || [], sh = x.shareholders || [];
  let h = `<div style="border:1px solid #cfe6d7;background:#f4faf6;border-radius:10px;padding:14px;margin:12px 0">
    <b>Read from last year's financial statements</b>
    <div class="muted" style="margin:4px 0 10px">Nothing below has been applied. Check each value against the signed accounts, correct anything wrong, then confirm.</div>`;
  if (x.note) h += `<div class="chk REVIEW">${esc(x.note)}</div>`;

  h += '<h4 style="margin:12px 0 4px;font-size:12px;color:var(--mut)">PARTICULARS</h4>';
  h += f.length ? `<table class="fin"><thead><tr><th>Field</th><th>Value read</th><th>Where it was found</th><th>Use?</th></tr></thead><tbody>`
    + f.map((x2, i) => `<tr><td>${esc(x2.label || x2.key)}</td>
        <td><input data-pf="${i}" value="${esc(x2.value)}" style="width:100%"></td>
        <td class="muted">${esc(x2.source)}</td>
        <td style="text-align:center"><input type="checkbox" data-pfu="${i}" checked></td></tr>`).join('')
    + '</tbody></table>' : '<p class="muted">No particulars could be read.</p>';

  h += '<h4 style="margin:14px 0 4px;font-size:12px;color:var(--mut)">COMPARATIVE FIGURES</h4>';
  h += fig.length ? `<div class="wrap" style="max-height:280px"><table class="fin"><thead><tr><th>Head</th><th>Caption in the document</th><th class="r">Amount</th><th>Source</th><th>Use?</th></tr></thead><tbody>`
    + fig.map((x2, i) => `<tr><td>${esc((S.heads.find((hh) => hh.lineId === x2.lineId) || {}).caption || x2.lineId)}</td>
        <td class="muted">${esc(x2.caption)}</td>
        <td class="r"><input data-pg="${i}" value="${x2.amount}" style="width:120px;text-align:right"></td>
        <td class="muted">${esc(x2.source)}</td>
        <td style="text-align:center"><input type="checkbox" data-pgu="${i}" checked></td></tr>`).join('')
    + '</tbody></table></div>'
    : '<p class="muted">No comparative figures were read. Key them in, or upload the Excel if you uploaded a PDF.</p>';

  if (sh.length) h += '<h4 style="margin:14px 0 4px;font-size:12px;color:var(--mut)">SHAREHOLDERS</h4>'
    + '<table class="fin"><tbody>' + sh.map((x2) =>
      `<tr><td>${esc(x2.name)}</td><td class="r">${x2.shares ?? ''}</td><td class="r">${x2.percent != null ? x2.percent + '%' : ''}</td></tr>`).join('')
    + '</tbody></table>';

  if ((x.unmatched || []).length) h += `<div class="chk REVIEW" style="margin-top:10px">
      ${x.unmatched.length} line(s) could not be matched to a Schedule III head and were left out —
      e.g. ${x.unmatched.slice(0, 3).map((u) => esc(u.label)).join('; ')}. Key those comparatives manually if they matter.</div>`;

  h += `<div style="margin-top:12px"><button class="btn" id="priorConfirm" type="button">Confirm and use these</button>
        <button class="btn ghost" id="priorDiscard" type="button">Discard</button></div></div>`;
  $('priorPreview').innerHTML = h;
  $('priorConfirm').onclick = confirmPrior;
  $('priorDiscard').onclick = () => { $('priorPreview').innerHTML = ''; S.prior = null; };
}

async function confirmPrior() {
  const x = S.prior; if (!x) return;
  const particulars = (x.fields || []).map((f, i) => ({ ...f,
    value: ($(`priorPreview`).querySelector(`[data-pf="${i}"]`) || {}).value ?? f.value,
    use: ($(`priorPreview`).querySelector(`[data-pfu="${i}"]`) || {}).checked,
  })).filter((f) => f.use && f.value).map((f) => ({ key: f.key, label: f.label, value: f.value, source: f.source, status: 'confirmed' }));
  const figures = (x.figures || []).map((g, i) => ({ ...g,
    amount: Number(($(`priorPreview`).querySelector(`[data-pg="${i}"]`) || {}).value ?? g.amount),
    use: ($(`priorPreview`).querySelector(`[data-pgu="${i}"]`) || {}).checked,
  })).filter((g) => g.use && Number.isFinite(g.amount))
    .map((g) => ({ lineId: g.lineId, amount: g.amount, source: g.source, caption: g.caption }));
  try {
    const r = await api(`/engagements/${S.eng.id}/prior-import`, { method: 'POST', body: JSON.stringify({
      figures, particulars, shareholders: x.shareholders || [] }) });
    $('priorPreview').innerHTML = `<div class="banner ok">Applied: ${r.figures} comparative figure(s), ${r.particulars} particular(s), ${r.shareholders} shareholder(s). The comparative column now comes from the signed accounts.</div>`;
    S.prior = null;
    await loadEngagements();
    const list = await api('/engagements');
    S.eng = list.engagements.find((e) => e.id === S.eng.id) || S.eng;
    $('engPill').textContent = S.eng.client_name + ' · FY ' + S.eng.fy_end.slice(0, 4);
    try { await refresh(); } catch { /* no snapshot yet */ }
  } catch (e) { alert('Could not apply: ' + e.message); }
}

/* ---------- presentation scale ------------------------------------------ */
$('scalePick').onchange = async () => {
  if (!S.eng) return;
  try {
    await api(`/engagements/${S.eng.id}/scale`, { method: 'POST', body: JSON.stringify({ scale: $('scalePick').value }) });
    await refresh();
  } catch (e) { alert(e.message); }
};

/* ---------- 7. observations --------------------------------------------- */
async function renderObservations() {
  if (!S.eng) return;
  try {
    const j = await api(`/engagements/${S.eng.id}/observations`);
    $('obsDisclaimer').textContent = j.disclaimer;
    $('obsKpi').innerHTML =
      kpi(j.summary.total, 'observations') +
      kpi(j.summary.blocking, 'blocking', j.summary.blocking ? 'bad' : 'good') +
      kpi(j.summary.high, 'high', j.summary.high ? 'bad' : 'good');
    const cls = { Blocking: 'CRITICAL', High: 'HIGH', Medium: 'REVIEW', Low: 'INFO' };
    let html = '';
    for (const a of j.summary.byArea) {
      html += `<h3 style="margin:16px 0 6px;font-size:13px;color:var(--green)">${esc(a.area)} <span class="muted">(${a.count})</span></h3>`;
      for (const o of j.observations.filter((x) => x.area === a.area)) {
        html += `<div class="chk ${cls[o.weight] || 'INFO'}">
          <div><span class="pill ${o.weight === 'Blocking' ? 'bad' : o.weight === 'High' ? 'warn' : 'info'}">${esc(o.weight)}</span>
            <b style="margin-left:6px">${esc(o.observation)}</b></div>
          <div style="margin-top:5px"><i>Basis:</i> ${esc(o.basis)}</div>
          <div style="margin-top:3px"><b>You must verify:</b> ${esc(o.verify)}</div>
        </div>`;
      }
    }
    $('obsList').innerHTML = html || '<div class="chk INFO">Nothing observed from the data available.</div>';
    reach(7);
  } catch (e) { $('obsList').innerHTML = `<div class="chk CRITICAL">Could not build observations: ${esc(e.message)}</div>`; }
}

/* ---------- boot -------------------------------------------------------- */
loadEngagements();
