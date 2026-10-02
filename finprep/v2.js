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

const S = { eng: null, payload: null, ledgers: null, maxStep: 1, tab: 'bs', heads: [], inputs: null, prior: null, comparatives: [],
            constitutions: [], owners: [], profitTo: 'capital' };
/** Is the open engagement a non-corporate entity (ICAI format)? */
const isNCE = () => !!(S.eng && S.eng.division === 'NCE');

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
const STEPS = 9;   // 1 engagement · 2 inputs · 3 import · 4 grouping · 5 adjustments · 6 statements · 7 exceptions · 8 observations · 9 export
function go(n) {
  if (n > S.maxStep) return;
  for (let i = 1; i <= STEPS; i++) $('s' + i).classList.toggle('hidden', i !== n);
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
/** The constitutions the server knows, and the framework each one reports in. */
async function loadConstitutions() {
  try {
    const { constitutions } = await api('/constitutions');
    S.constitutions = constitutions;
    $('cCon').innerHTML = constitutions.map((c) => `<option value="${esc(c.key)}">${esc(c.label)}</option>`).join('');
    onConstitutionPick();
  } catch (e) { msg('m1', 'Could not reach the server: ' + e.message, 'bad'); }
}
function onConstitutionPick() {
  const c = S.constitutions.find((x) => x.key === $('cCon').value) || {};
  $('cDivWrap').classList.toggle('hidden', !c.isCorporate);
  $('cCinWrap').classList.toggle('hidden', !c.isCorporate);
  $('cFramework').textContent = c.isCorporate
    ? 'A company reports under Schedule III — pick Division I (AS) or Division II (Ind AS).'
    : (c.framework ? `Reports in the ${c.framework}: owners’ funds in place of share capital, with ${String(c.owners || 'the owners').toLowerCase()}’ capital accounts prepared owner by owner.` : '');
}
$('cCon').onchange = onConstitutionPick;

async function loadEngagements() {
  try {
    const { engagements } = await api('/engagements');
    // Only offer the "continue" picker once there is something to continue.
    $('engExisting').classList.toggle('hidden', engagements.length === 0);
    $('engFirst').classList.toggle('hidden', engagements.length > 0);
    // grouped by client, newest year first, so a practice with many clients can find one
    const byClient = new Map();
    for (const e of engagements) {
      const k = e.client_name.trim().toLowerCase();
      if (!byClient.has(k)) byClient.set(k, { name: e.client_name, items: [] });
      byClient.get(k).items.push(e);
    }
    S.engagements = engagements;
    $('engList').innerHTML = [...byClient.values()].sort((a, b) => a.name.localeCompare(b.name)).map((c) =>
      `<optgroup label="${esc(c.name)}">` + c.items.sort((a, b) => b.fy_end.localeCompare(a.fy_end)).map((e) =>
        `<option value="${e.id}">FY ${esc(e.fy_start)} to ${esc(e.fy_end)} · ${esc(e.constitutionLabel || e.constitution || 'Company')} (${e.division})</option>`).join('') + '</optgroup>').join('');
  } catch (e) { msg('m1', 'Could not reach the server: ' + e.message, 'bad'); }
}
/** Pre-fill the form for the same client's next year; the preparer presses Create. */
$('engNext').onclick = () => {
  const e = (S.engagements || []).find((x) => x.id === $('engList').value);
  if (!e) return;
  const shift = (iso) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCFullYear(d.getUTCFullYear() + 1); return d.toISOString().slice(0, 10); };
  $('cName').value = e.client_name; $('cCin').value = e.cin || ''; $('cPan').value = e.pan || '';
  $('cCon').value = e.constitution || 'company'; onConstitutionPick();
  if (e.division !== 'NCE') $('cDiv').value = e.division;
  $('cStart').value = shift(e.fy_start); $('cEnd').value = shift(e.fy_end);
  msg('m1', `Form filled for ${e.client_name}, FY ${shift(e.fy_start)} to ${shift(e.fy_end)}. Press Create, import the books, then use “Carry forward last year’s grouping” in step 4.`, 'ok');
  $('cName').scrollIntoView({ behavior: 'smooth', block: 'center' });
};
async function openEngagement(id) {
  const { engagements } = await api('/engagements');
  S.eng = engagements.find((e) => e.id === id);
  if (!S.eng) return;
  S.heads = [];                                         // the chart depends on the division
  $('engPill').textContent = S.eng.client_name + ' · FY ' + S.eng.fy_end.slice(0, 4);
  $('bandSub').textContent = S.eng.division === 'NCE' ? '· ICAI non-corporate format · ' + (S.eng.constitutionLabel || '')
    : S.eng.division === 'INDAS' ? '· Schedule III, Division II' : '· Schedule III, Division I';
  $('pFrom').value = S.eng.fy_start; $('pTo').value = S.eng.fy_end;
  if (S.eng.scale) $('scalePick').value = S.eng.scale;
  $('ownCard').classList.toggle('hidden', !isNCE());
  reach(3); go(2);
  await loadInputs();
  if (isNCE()) await loadOwners();
  try { await refresh(); await showVariance(); } catch { /* no snapshot yet — expected */ }
}
$('engNew').onclick = async () => {
  try {
    const { id } = await api('/engagements', { method: 'POST', body: JSON.stringify({
      clientName: $('cName').value.trim(), cin: $('cCin').value.trim(), pan: $('cPan').value.trim().toUpperCase(),
      constitution: $('cCon').value,
      fyStart: $('cStart').value, fyEnd: $('cEnd').value, division: $('cDiv').value }) });
    msg('m1', 'Engagement created.', 'ok');
    await loadEngagements(); $('engList').value = id; await openEngagement(id);
  } catch (e) { msg('m1', e.message, 'bad'); }
};

/* ---------- owners: proprietor, partners, karta ------------------------- */
const OWNER_KINDS = [['capital', 'owners_capital'], ['current', 'partners_current'], ['drawings', 'owners_capital'],
                     ['remuneration', 'partners_remuneration'], ['interest', 'interest_on_capital']];
async function loadOwners() {
  if (!S.eng) return;
  const j = await api(`/engagements/${S.eng.id}/owners`);
  S.owners = j.owners || []; S.profitTo = j.profitTo || 'capital';
  $('ownProfitTo').value = S.profitTo;
  const con = S.constitutions.find((c) => c.key === S.eng.constitution) || {};
  $('ownTitle').textContent = (con.owners || 'Owners') + ' and profit sharing';
  renderOwners();
}
/** Ledgers a picker may offer: those on the kind's line, plus any already chosen. */
function ownerLedgerOptions(kind, lineId, chosen) {
  const tb = (S.payload && S.payload.trialBalance) || [];
  const names = new Set(tb.filter((r) => r.lineId === lineId).map((r) => r.ledger));
  for (const c of chosen) names.add(c);
  return [...names].sort().map((n) => `<option value="${esc(n)}"${chosen.includes(n) ? ' selected' : ''}>${esc(n)}</option>`).join('');
}
function renderOwners() {
  const con = S.constitutions.find((c) => c.key === (S.eng || {}).constitution) || {};
  const auto = ((S.payload || {}).ownersAccounts || {}).assignments || [];
  $('ownRows').innerHTML = S.owners.map((o, i) => `<tr data-i="${i}">
    <td><input class="o-name" value="${esc(o.name)}" style="width:150px"></td>
    <td><input class="o-role" value="${esc(o.role || con.ownerRole || '')}" style="width:110px"></td>
    <td><input class="o-pan" value="${esc(o.pan || '')}" style="width:110px;text-transform:uppercase"></td>
    <td class="r"><input class="o-ratio" type="number" min="0" step="any" value="${o.ratio || ''}" style="width:70px;text-align:right"></td>
    <td class="r"><input class="o-split" type="number" step="0.01" value="${o.split == null ? '' : o.split}" placeholder="by ratio" style="width:120px;text-align:right"></td>
    ${OWNER_KINDS.map(([k, line]) => `<td><select multiple class="pick" data-kind="${k}" title="Hold Ctrl to pick several">${ownerLedgerOptions(k, line, (o.ledgers || {})[k] || [])}</select></td>`).join('')}
    <td><button class="btn ghost sm" data-del="${i}" type="button" title="Remove">×</button></td>
  </tr>`).join('') || `<tr><td colspan="11" class="muted">No ${String(con.owners || 'owners').toLowerCase()} recorded yet — press “+ Add”.</td></tr>`;
  $('ownRows').querySelectorAll('[data-del]').forEach((b) => b.onclick = () => { readOwnerRows(); S.owners.splice(+b.dataset.del, 1); renderOwners(); });
  const sum = S.owners.reduce((t, o) => t + (Number(o.ratio) || 0), 0);
  $('ownNote').innerHTML = (auto.length
    ? `Matched by name: ${auto.map((a) => `${esc(a.ledger)} → ${esc(a.owner)} (${a.kind})`).join(' · ')}. Save to make these explicit.<br>` : '')
    + (S.owners.length ? `Ratios add to ${sum}; each share is ratio ÷ ${sum || 1}. ` : '')
    + 'A ledger left unassigned is shown in an “unallocated” column of the capital account until it is placed.';
}
function readOwnerRows() {
  const rows = [...$('ownRows').querySelectorAll('tr[data-i]')];
  S.owners = rows.map((tr, i) => {
    const prev = S.owners[i] || {};
    const ledgers = {};
    tr.querySelectorAll('select.pick').forEach((s) => { ledgers[s.dataset.kind] = [...s.selectedOptions].map((x) => x.value); });
    const split = tr.querySelector('.o-split').value;
    return { id: prev.id, name: tr.querySelector('.o-name').value.trim(), role: tr.querySelector('.o-role').value.trim(),
      pan: tr.querySelector('.o-pan').value.trim().toUpperCase(), ratio: Number(tr.querySelector('.o-ratio').value) || 0,
      split: split === '' ? null : Number(split), ledgers };
  });
}
$('ownAdd').onclick = () => { readOwnerRows(); S.owners.push({ name: '', ratio: S.owners.length ? 0 : 1, ledgers: {} }); renderOwners(); };
$('ownSave').onclick = async () => {
  readOwnerRows();
  const owners = S.owners.filter((o) => o.name);
  try {
    const j = await api(`/engagements/${S.eng.id}/owners`, { method: 'PUT', body: JSON.stringify({ owners, profitTo: $('ownProfitTo').value }) });
    S.owners = j.owners; S.profitTo = j.profitTo;
    await refresh();
    renderOwners();
    msg('mOwn', `${owners.length} saved and the statements rebuilt.`, 'ok');
  } catch (e) { msg('mOwn', e.message, 'bad'); }
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
    await refresh(); await showVariance(); reach(4); go(4);
  } catch (e) { msg('m2', 'Import failed: ' + e.message, 'bad'); }
};
const kpi = (v, t, cls = '') => `<div class="k ${cls}"><div class="v">${esc(v)}</div><div class="t">${esc(t)}</div></div>`;

/* ---------- 2b. an Excel trial balance ---------------------------------- */
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 1500);
}
$('tplDl').onclick = async () => {
  if (!S.eng) return msg('mTpl', 'Open or create the engagement first — the template carries its heads.', 'bad');
  try {
    if (!window.ExcelJS) throw new Error('the Excel library is still loading — try again in a moment');
    if (!S.heads.length) await loadHeads();
    const mod = await import('./core/tbTemplate.js');
    const wb = mod.buildTemplate(window.ExcelJS, { heads: S.heads.filter((h) => h.section !== 'UNCLASSIFIED'),
      entity: S.eng.client_name, fyEnd: S.eng.fy_end, framework: isNCE() ? 'ICAI format for non-corporate entities' : 'Schedule III' });
    const buf = await wb.xlsx.writeBuffer();
    download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      'Trial_balance_template_' + S.eng.client_name.replace(/[^A-Za-z0-9]+/g, '_') + '.xlsx');
    msg('mTpl', 'Template downloaded. Fill the "Trial Balance" sheet and upload it here.', 'ok');
  } catch (e) { msg('mTpl', e.message, 'bad'); }
};
$('tplGo').onclick = async () => {
  if (!S.eng) return msg('mTpl', 'Open or create the engagement first.', 'bad');
  const f = $('tplFile').files[0];
  if (!f) return msg('mTpl', 'Choose the filled template first.', 'bad');
  msg('mTpl', 'Reading the sheet…');
  $('tplReport').innerHTML = '';
  try {
    if (!window.ExcelJS) throw new Error('the Excel library is still loading — try again in a moment');
    if (!S.heads.length) await loadHeads();
    const mod = await import('./core/tbTemplate.js');
    const res = await mod.readTemplate(window.ExcelJS, await f.arrayBuffer(), { heads: S.heads });
    const list = (items, cls) => items.map((x) => `<div class="chk ${cls}">${esc(x)}</div>`).join('');
    if (res.errors.length) {
      $('tplReport').innerHTML = `<div class="banner bad">Not imported — ${res.errors.length} problem(s) in the sheet${res.sheet ? ' “' + esc(res.sheet) + '”' : ''}. Fix them and upload again.</div>`
        + list(res.errors, 'CRITICAL') + list(res.warnings, 'REVIEW');
      return msg('mTpl', 'The sheet was refused.', 'bad');
    }
    const t = res.totals;
    const snap = await api(`/engagements/${S.eng.id}/snapshots`, { method: 'POST', body: JSON.stringify({
      source: 'excel', method: 'file', company: f.name, periodFrom: S.eng.fy_start, periodTo: S.eng.fy_end, ledgers: res.ledgers }) });
    if (res.mappings.length) await api(`/engagements/${S.eng.id}/mappings`, { method: 'POST', body: JSON.stringify({ mappings: res.mappings }) });
    $('k2').innerHTML =
      kpi(snap.ledgerCount, 'ledgers sealed into the snapshot') +
      kpi(inr(snap.controlTotals.current), 'trial balance total (must be nil)', snap.balanced ? 'good' : 'bad') +
      kpi(t.withHead, 'heads given in the sheet') + kpi(t.withMovements, 'ledgers with gross movements');
    $('tplReport').innerHTML = list(res.warnings, 'REVIEW');
    msg('mTpl', `Imported ${res.ledgers.length} ledgers from “${esc(res.sheet)}” (closing Dr ${inr(t.closeDr)} = Cr ${inr(t.closeCr)}).`, 'ok');
    $('tplFile').value = '';
    await refresh();
    await showVariance();
    reach(4); go(4);
  } catch (e) { msg('mTpl', 'Import failed: ' + e.message, 'bad'); }
};
/** Ledger by ledger, what this import changed against the previous one. */
async function showVariance() {
  if (!S.eng) return;
  try {
    const v = await api(`/engagements/${S.eng.id}/variance`);
    if (!v.summary) { $('varCard').classList.add('hidden'); return; }
    $('varCard').classList.remove('hidden');
    $('varSub').textContent = `Previous import ${String(v.from.takenAt).slice(0, 16).replace('T', ' ')} (${v.from.source}) against this one ${String(v.to.takenAt).slice(0, 16).replace('T', ' ')} (${v.to.source}). Approved heads, note captions, owners and adjustments carry over by ledger name.`;
    const s = v.summary;
    $('varKpi').innerHTML = kpi(s.changed, 'ledgers changed', s.changed ? '' : 'good') + kpi(s.added, 'new ledgers', s.added ? '' : 'good')
      + kpi(s.dropped, 'ledgers gone', s.dropped ? 'bad' : 'good') + kpi(s.same, 'unchanged') + kpi(inr(s.grossCurrent), 'gross change in closing balances');
    const cls = { added: 'ok', dropped: 'bad', changed: 'warn' };
    $('varRows').innerHTML = v.rows.length ? v.rows.map((r) => `<tr>
      <td>${esc(r.ledger)}</td><td class="muted">${esc(r.group || '')}${r.groupChanged ? ' <span class="pill warn">group changed</span>' : ''}</td>
      <td><span class="pill ${cls[r.status] || 'info'}">${esc(r.status)}</span></td>
      <td class="r">${r.wasCurrent == null ? '—' : inr(r.wasCurrent)}</td><td class="r">${r.nowCurrent == null ? '—' : inr(r.nowCurrent)}</td>
      <td class="r"><b>${inr(r.deltaCurrent)}</b></td>
      <td class="r">${r.wasPrior == null ? '—' : inr(r.wasPrior)}</td><td class="r">${r.nowPrior == null ? '—' : inr(r.nowPrior)}</td></tr>`).join('')
      : '<tr><td colspan="8" class="muted">Nothing changed between the two imports.</td></tr>';
  } catch { $('varCard').classList.add('hidden'); }
}

/* ---------- refresh the whole model ------------------------------------ */
async function refresh() {
  const j = await api(`/engagements/${S.eng.id}/statements`);
  S.payload = j;
  if (!S.heads.length) await loadHeads();
  renderGrouping(); renderJournals(); renderStatements(); renderChecks(); renderExport();
  if (isNCE()) renderOwners();
  reach(6);
  renderObservations();
  checkCarryForward();
}

/* ---------- carry forward last year's decisions -------------------------- */
async function checkCarryForward() {
  if (!S.eng) return;
  try {
    const j = await api(`/engagements/${S.eng.id}/carry-forward`);
    const c = j.candidate;
    $('cfBtn').classList.toggle('hidden', !c);
    if (c) $('cfBtn').title = `Copy from the engagement for FY ending ${c.fyEnd}: ${c.mappings} approved head(s), ${c.subgroups} note caption(s)${c.owners ? ', ' + c.owners + ' owner(s)' : ''} — for ledgers still in the books. Nothing decided this year is overwritten.`;
  } catch { $('cfBtn').classList.add('hidden'); }
}
$('cfBtn').onclick = async () => {
  try {
    const j = await api(`/engagements/${S.eng.id}/carry-forward`, { method: 'POST', body: '{}' });
    const c = j.carried, s = j.skipped;
    msg('mCf', `Carried from FY ending ${j.from.fyEnd}: ${c.mappings} head(s), ${c.subgroups} caption(s), ${c.owners} owner(s).`
      + (s.alreadySet ? ` ${s.alreadySet} already decided this year were left alone.` : '')
      + (s.notInBooks.length ? ` ${s.notInBooks.length} ledger(s) from last year are not in this year's books: ${s.notInBooks.slice(0, 5).join('; ')}${s.notInBooks.length > 5 ? '…' : ''}.` : ''), 'ok');
    if (isNCE()) await loadOwners();
    await refresh();
  } catch (e) { msg('mCf', e.message, 'bad'); }
};

/* ---------- 5. adjustment entries ---------------------------------------- */
function renderJournals() {
  const j = S.payload; if (!j) return;
  const list = j.journals || [];
  const side = (a) => (a >= 0 ? `<td class="r">${inr(a)}</td><td class="r"></td>` : `<td class="r"></td><td class="r">${inr(-a)}</td>`);
  $('jrnList').innerHTML = list.length ? list.map((x) => `
    <div class="chk ${x.approved ? 'INFO' : 'HIGH'}" style="padding:10px 12px">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <span class="pill ${x.approved ? 'ok' : 'warn'}">${x.approved ? 'approved' : 'pending'}</span>
        <b>${esc(x.narration)}</b> <span class="muted">· ${esc(x.kind)} · ${x.period === 'prior' ? 'comparative year' : 'current year'} · ${esc(String(x.createdAt || '').slice(0, 10))}</span>
        <span style="margin-left:auto"></span>
        <button class="btn ghost sm" data-japp="${esc(x.id)}" data-on="${x.approved ? 0 : 1}" type="button">${x.approved ? 'Take back approval' : 'Approve'}</button>
        <button class="btn ghost sm" data-jedit="${esc(x.id)}" type="button">Edit</button>
        <button class="btn ghost sm" data-jdel="${esc(x.id)}" type="button">Withdraw</button>
      </div>
      <table class="fin" style="margin-top:6px"><tbody>${x.entries.map((e) => `<tr${e.missing ? ' style="background:var(--bad-soft)"' : ''}>
        <td>${e.ledgerName ? esc(e.ledgerName) + (e.missing ? ' <span class="pill bad">not in the books any more</span>' : '') : '<i>' + esc(e.lineCaption || e.lineId) + '</i> <span class="muted">(head)</span>'}</td>${side(e.amount)}</tr>`).join('')}</tbody></table>
    </div>`).join('')
    : '<div class="chk INFO">No adjustment entries yet. Everything on the statements is exactly what the books hold.</div>';
  $('jrnList').querySelectorAll('[data-japp]').forEach((b) => b.onclick = async () => {
    try { await api(`/engagements/${S.eng.id}/journals/${b.dataset.japp}/approve`, { method: 'POST', body: JSON.stringify({ approved: b.dataset.on === '1' }) }); await refresh(); }
    catch (e) { alert(e.message); }
  });
  $('jrnList').querySelectorAll('[data-jdel]').forEach((b) => b.onclick = async () => {
    if (!confirm('Withdraw this entry? It stays on the record but is no longer applied.')) return;
    try { await api(`/engagements/${S.eng.id}/journals/${b.dataset.jdel}`, { method: 'DELETE' }); await refresh(); }
    catch (e) { alert(e.message); }
  });
  $('jrnList').querySelectorAll('[data-jedit]').forEach((b) => b.onclick = () => {
    const x = list.find((y) => y.id === b.dataset.jedit); if (!x) return;
    S.jEditing = x.id;
    $('jNarr').value = x.narration; $('jKind').value = x.kind || 'reclass'; $('jPeriod').value = x.period || 'current';
    S.jLines = x.entries.map((e) => ({ ledger: e.ledgerName || '', lineId: e.lineId || '', dr: e.amount > 0 ? e.amount : '', cr: e.amount < 0 ? -e.amount : '' }));
    renderJLines();
    msg('mJ', 'Editing — saving records a new entry and withdraws the old one, so the trail stays.', '');
    $('jNarr').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  // the ledger search: every ledger in the trial balance, no cap
  $('jLedgers').innerHTML = (j.trialBalance || []).map((r) => `<option value="${esc(r.ledger)}">`).join('');
  if (!S.jLines) { S.jLines = [{}, {}]; renderJLines(); }
}
function renderJLines() {
  const heads = headOptions(null).replace(/ selected/g, '');
  $('jRows').innerHTML = S.jLines.map((l, i) => `<tr data-i="${i}">
    <td><input class="j-led" list="jLedgers" value="${esc(l.ledger || '')}" placeholder="ledger name" style="width:100%"></td>
    <td><select class="j-head" style="width:100%;font-size:12px"><option value="">— no head —</option>${heads}</select></td>
    <td class="r"><input class="j-dr" type="number" step="0.01" min="0" value="${l.dr === '' || l.dr == null ? '' : l.dr}" style="width:120px;text-align:right"></td>
    <td class="r"><input class="j-cr" type="number" step="0.01" min="0" value="${l.cr === '' || l.cr == null ? '' : l.cr}" style="width:120px;text-align:right"></td>
    <td><button class="btn ghost sm" data-jrm="${i}" type="button">×</button></td></tr>`).join('');
  $('jRows').querySelectorAll('tr').forEach((tr, i) => { const sel = tr.querySelector('.j-head'); if (S.jLines[i].lineId) sel.value = S.jLines[i].lineId; });
  $('jRows').querySelectorAll('[data-jrm]').forEach((b) => b.onclick = () => { readJLines(); S.jLines.splice(+b.dataset.jrm, 1); if (!S.jLines.length) S.jLines = [{}]; renderJLines(); });
  $('jRows').querySelectorAll('input,select').forEach((el) => el.onchange = () => { readJLines(); jTotals(); });
  jTotals();
}
function readJLines() {
  S.jLines = [...$('jRows').querySelectorAll('tr')].map((tr) => ({
    ledger: tr.querySelector('.j-led').value.trim(), lineId: tr.querySelector('.j-head').value,
    dr: tr.querySelector('.j-dr').value === '' ? '' : Number(tr.querySelector('.j-dr').value),
    cr: tr.querySelector('.j-cr').value === '' ? '' : Number(tr.querySelector('.j-cr').value) }));
}
function jTotals() {
  const dr = S.jLines.reduce((t, l) => t + (Number(l.dr) || 0), 0), cr = S.jLines.reduce((t, l) => t + (Number(l.cr) || 0), 0);
  $('jDr').textContent = inr(dr); $('jCr').textContent = inr(cr);
  const diff = Math.round((dr - cr) * 100) / 100;
  $('jDiff').innerHTML = diff ? `<span style="color:var(--bad)">out by ${inr(Math.abs(diff))}</span>` : (dr ? '<span style="color:var(--ok)">balances</span>' : '');
}
$('jAddRow').onclick = () => { readJLines(); S.jLines.push({}); renderJLines(); };
async function saveJournal(approve) {
  readJLines();
  const entries = S.jLines.filter((l) => (Number(l.dr) || 0) || (Number(l.cr) || 0)).map((l) => {
    const amount = (Number(l.dr) || 0) - (Number(l.cr) || 0);
    return l.ledger ? { ledgerKey: l.ledger, amount } : { lineId: l.lineId || null, amount };
  });
  if (!$('jNarr').value.trim()) return msg('mJ', 'Give the entry a narration — the reason it is being passed.', 'bad');
  if (entries.some((e) => !e.ledgerKey && !e.lineId)) return msg('mJ', 'Every line needs a ledger or a head.', 'bad');
  if (entries.length < 2) return msg('mJ', 'An entry needs at least two lines.', 'bad');
  const body = { narration: $('jNarr').value.trim(), kind: $('jKind').value, period: $('jPeriod').value, entries, approve };
  try {
    if (S.jEditing) await api(`/engagements/${S.eng.id}/journals/${S.jEditing}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api(`/engagements/${S.eng.id}/journals`, { method: 'POST', body: JSON.stringify(body) });
    S.jEditing = null; S.jLines = [{}, {}]; $('jNarr').value = '';
    await refresh();
    msg('mJ', approve ? 'Recorded, approved and applied to the statements.' : 'Recorded as pending — it is not applied until approved.', 'ok');
  } catch (e) { msg('mJ', e.message, 'bad'); }
}
$('jSavePending').onclick = () => saveJournal(false);
$('jSaveApprove').onclick = () => saveJournal(true);
/**
 * The full chart of heads for this division, from the server. It must NOT be
 * derived from the heads already in use, or a head could never be assigned for
 * the first time.
 */
async function loadHeads() {
  const div = (S.eng && S.eng.division) || 'AS';
  const con = (S.eng && S.eng.constitution) || 'company';
  const { lines } = await api('/lines?division=' + div + '&constitution=' + encodeURIComponent(con));
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
  const fromTally = rows.filter((x) => x.subGroupSource === 'tally').length;
  const proposed = rows.filter((x) => x.subGroupSource === 'proposed').length;
  $('gRows').innerHTML = rows.length ? rows.map((r) => `
    <tr${r.lineId === 'unclassified' ? ' style="background:var(--bad-soft)"' : ''}>
      <td>${esc(r.ledger)}</td>
      <td class="muted">${esc(r.group || '')}${r.tallySubGroup
          ? ` <span style="color:var(--ok)">▸ ${esc(r.tallySubGroup)}</span>` : ''}</td>
      <td class="r">${inr(r.current)} <span class="muted">${r.drcr}</span></td>
      <td><select class="assign" data-led="${esc(r.ledger)}">${opts(r.lineId)}</select></td>
      <td><input class="subg" data-led="${esc(r.ledger)}" value="${esc(r.subGroup || '')}"
           placeholder="(own line)" style="width:100%;font-size:12px;${SRC_STYLE[r.subGroupSource] || ''}"
           title="${esc(SRC_HINT[r.subGroupSource] || 'The caption this ledger appears under on the note.')}"></td>
    </tr>`).join('')
    : '<tr><td colspan="5" class="muted">Nothing to review under this filter.</td></tr>';
  $('m3').textContent = `${rows.length} shown of ${j.trialBalance.length} ledgers.`
    + (fromTally ? ` ${fromTally} sub-grouped in Tally.` : '')
    + (proposed ? ` ${proposed} caption(s) proposed by the tool — check these.` : '');
}
/* Where a note caption came from, so a proposal is never mistaken for a fact. */
const SRC_STYLE = {
  tally: 'border-color:var(--ok)',
  preparer: 'border-color:var(--ok);font-weight:600',
  proposed: 'border-color:var(--warn);background:var(--warn-soft)',
};
const SRC_HINT = {
  tally: 'Taken from the sub-group this ledger sits under in Tally. Ledgers sharing it are shown as one note line.',
  preparer: 'You set this caption. It overrides Tally.',
  proposed: 'PROPOSED by the tool from the ledger’s wording — this ledger is not sub-grouped in Tally. Check it, or sub-group it in Tally.',
  ledger: 'Not sub-grouped in Tally, so the ledger is shown on its own line under its own name.',
};
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
    go(6);
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
    ? `<div class="banner bad">DRAFT — NOT FOR ISSUE · ${crit.length} unresolved critical exception(s). See step 7.</div>`
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
      if (n.kind === 'owners' && n.schedule) h += `<tr><td colspan="3" style="padding:8px 0 10px">${ownersTable(n.schedule, m)}</td></tr>`;
      for (const s of n.subLines) {
        h += `<tr><td>${esc(s.name)}</td><td class="r">${inr(s.current)}</td><td class="r">${inr(s.prior)}</td></tr>`;
        // the ledgers behind a sub-grouped line, so the figure stays traceable
        if ((s.members || []).length > 1) h += `<tr><td colspan="3" class="muted" style="padding-left:22px">`
          + (s.source === 'proposed' ? '<b>proposed grouping — not sub-grouped in Tally:</b> ' : '')
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

/** The owner-by-owner statement of a capital or current account. */
function ownersTable(s, m) {
  const cols = s.owners || [];
  const un = s.unallocated && s.unallocated.length;
  let h = `<table class="fin own" style="width:auto;min-width:60%"><thead><tr><th>${esc(m.ownersLabel || 'Owners')} — ${s.kind === 'capital' ? 'capital' : 'current'} accounts, year ended ${esc(m.currentLabel)}</th>`;
  for (const o of cols) h += `<th class="r">${esc(o.name)}${o.ratio ? `<div class="muted" style="font-weight:400">ratio ${o.ratio}</div>` : ''}</th>`;
  if (un) h += `<th class="r">Unallocated<div class="muted" style="font-weight:400" title="${esc(s.unallocated.join(', '))}">${s.unallocated.length} ledger(s)</div></th>`;
  h += '<th class="r">Total</th></tr></thead><tbody>';
  for (const r of s.rows) {
    const bold = r.key === 'opening' || r.key === 'closing';
    const any = cols.some((o) => r.byOwner[o.id]) || r.unallocated || r.total;
    if (!any && !bold) continue;
    h += `<tr class="${r.key === 'closing' ? 'tot' : ''}"><td>${esc(r.caption)}</td>`;
    for (const o of cols) h += `<td class="r">${inr(r.byOwner[o.id] || 0)}</td>`;
    if (un) h += `<td class="r">${inr(r.unallocated || 0)}</td>`;
    h += `<td class="r">${inr(r.total || 0)}</td></tr>`;
  }
  h += '</tbody></table>';
  if (s.profitTo) h += `<div class="muted" style="margin-top:4px">Share of profit ${esc(s.shareBasis || 'by profit-sharing ratio')}.</div>`;
  return h;
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
  reach(7);
}

/* ---------- 6. export --------------------------------------------------- */
function renderExport() {
  const j = S.payload; if (!j) return;
  const crit = j.checks.filter((c) => c.severity === 'CRITICAL');
  $('exBanner').innerHTML = crit.length
    ? `<div class="banner bad">${crit.length} critical exception(s) outstanding — the workbook will be watermarked DRAFT — NOT FOR ISSUE and cannot be marked Final.</div>`
    : `<div class="banner ok">No critical exceptions. The workbook may be issued as a reviewed draft.</div>`;
  reach(9);
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
      + (isNCE() ? '_Financials_' : '_ScheduleIII_') + (S.payload.meta.currentLabel || '').replace(/\s+/g, '_') + '.xlsx';
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
  await loadComparatives();
}

/* ---------- comparatives on file --------------------------------------- */
/**
 * Every prior-year figure the statements will use, head by head, editable.
 * The import fills this in; where it could not read a statement — a P&L whose
 * layout it does not recognise, or a set supplied only as a PDF — the
 * comparatives can still be keyed in here rather than silently reading nil.
 */
const PL_SECTIONS = ['INCOME', 'EXPENSE', 'TAX', 'OCI'];
async function loadComparatives() {
  if (!S.eng) return;
  if (!S.heads.length) await loadHeads();
  const { figures } = await api(`/engagements/${S.eng.id}/prior-import`);
  S.comparatives = figures.map((f) => ({ ...f }));
  $('cmpHead').innerHTML = headOptions(null);
  renderComparatives();
}
function renderComparatives() {
  const rows = (S.comparatives || []).slice();
  const head = (id) => S.heads.find((h) => h.lineId === id) || {};
  const stmt = (id) => (PL_SECTIONS.includes(head(id).section) ? 'Profit and loss' : 'Balance sheet');
  rows.sort((a, b) => stmt(a.lineId).localeCompare(stmt(b.lineId)) || (head(a.lineId).caption || '').localeCompare(head(b.lineId).caption || ''));
  const nPL = rows.filter((r) => PL_SECTIONS.includes(head(r.lineId).section)).length;
  $('cmpRows').innerHTML = rows.length ? rows.map((r, i) => `
    <tr><td class="muted">${esc(stmt(r.lineId))}</td>
      <td>${esc(head(r.lineId).caption || r.lineId)}</td>
      <td class="r"><input data-cmp="${i}" type="number" step="0.01" value="${r.amount}" style="width:150px;text-align:right"></td>
      <td class="muted">${esc(r.source || 'keyed in')}${r.caption ? ' — “' + esc(r.caption) + '”' : ''}</td>
      <td><button class="btn ghost sm" data-cmpdel="${i}" type="button">Remove</button></td></tr>`).join('')
    : '<tr><td colspan="5" class="muted">No comparative is on file. The prior column will come from Tally.</td></tr>';
  msg('mCmp', `${rows.length - nPL} on the balance sheet · ${nPL} on the statement of profit and loss.`,
    rows.length && !nPL ? 'bad' : '');
  $('cmpRows').querySelectorAll('[data-cmpdel]').forEach((b) => b.onclick = () => {
    S.comparatives.splice(+b.dataset.cmpdel, 1); renderComparatives();
  });
  $('cmpRows').querySelectorAll('[data-cmp]').forEach((inp) => inp.onchange = () => {
    S.comparatives[+inp.dataset.cmp].amount = Number(inp.value) || 0;
    S.comparatives[+inp.dataset.cmp].source = 'keyed in by the preparer';
  });
}
$('cmpAdd').onclick = () => {
  const lineId = $('cmpHead').value, amount = Number($('cmpAmt').value);
  if (!lineId || !Number.isFinite(amount)) return msg('mCmp', 'Pick a head and type an amount.', 'bad');
  S.comparatives = S.comparatives || [];
  const at = S.comparatives.findIndex((x) => x.lineId === lineId);
  const row = { lineId, amount, source: 'keyed in by the preparer', caption: null };
  if (at >= 0) S.comparatives[at] = row; else S.comparatives.push(row);
  $('cmpAmt').value = '';
  renderComparatives();
};
$('cmpSave').onclick = async () => {
  try {
    await api(`/engagements/${S.eng.id}/prior-import`, { method: 'POST', body: JSON.stringify({
      figures: S.comparatives || [], particulars: [], shareholders: [], replace: 'figures' }) });
    await refresh().catch(() => {});
    msg('mCmp', 'Saved. The comparative column now uses these figures.', 'ok');
  } catch (e) { msg('mCmp', e.message, 'bad'); }
};

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
/** The comparative year this engagement needs: the year before its FY end. */
function priorYear() {
  const y = Number(String((S.eng && S.eng.fy_end) || '').slice(0, 4));
  return Number.isFinite(y) && y > 1900 ? y - 1 : null;
}

async function extractPrior(file, opts = {}) {
  if (file) { S.priorBuf = await file.arrayBuffer(); S.priorName = file.name; }
  const buf = S.priorBuf;
  if (!buf) throw new Error('no document is loaded');
  const mod = await import('./core/priorImport.js');
  if (/\.pdf$/i.test(S.priorName || '')) {
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
  return mod.readWorkbook(window.ExcelJS, buf, (S.eng && S.eng.division) || 'AS', {
    priorYear: opts.year !== undefined ? opts.year : priorYear(),
    unitsFactor: opts.unitsFactor,
  });
}

/** Re-read the document already in hand with a different year or scale. */
async function reReadPrior() {
  if (!S.priorBuf) return;
  const y = ($('priorYearPick') || {}).value;
  const u = ($('priorUnitPick') || {}).value;
  $('priorPreview').innerHTML = '<p class="muted">Re-reading the document…</p>';
  try {
    renderPriorPreview(await extractPrior(null, {
      year: y ? Number(y) : undefined,
      unitsFactor: u ? Number(u) : undefined,
    }));
  } catch (e) { $('priorPreview').innerHTML = `<div class="chk CRITICAL">Could not re-read it: ${esc(e.message)}</div>`; }
}

function renderPriorPreview(x) {
  S.prior = x;
  const f = x.fields || [], fig = x.figures || [], sh = x.shareholders || [];
  let h = `<div style="border:1px solid #cfe6d7;background:#f4faf6;border-radius:10px;padding:14px;margin:12px 0">
    <b>Read from last year's financial statements</b>
    <div class="muted" style="margin:4px 0 10px">Nothing below has been applied. Check each value against the signed accounts, correct anything wrong, then confirm.</div>`;
  if (x.note) h += `<div class="chk REVIEW">${esc(x.note)}</div>`;

  // WHICH COLUMN and WHAT SCALE. Both are decisions, not facts, and a wrong
  // one is invisible in the numbers -- a working file for THIS year shows this
  // year first, and "(All amounts in '000)" is a thousandfold error. So both
  // are stated, and both can be changed without uploading the file again.
  const yr = priorYear();
  const cols = x.columns || [], units = x.units || [];
  const years = [...new Set(cols.flatMap((c) => c.all.map((a) => a.year)).filter(Boolean))].sort((a, b) => b - a);
  // the same scales the tool itself presents in (money.js SCALES)
  const UNIT_OPTS = [['', 'as stated in the document'], ['1', 'rupees'], ['100', "hundreds ('00)"],
                     ['1000', "thousands ('000)"], ['100000', 'lakhs'],
                     ['1000000', 'millions'], ['10000000', 'crores']];
  const unitNow = units.length ? String(units[0].applied) : '';
  h += `<div style="border:1px solid var(--rule);border-radius:8px;padding:10px 12px;margin:10px 0;background:#fff">
    <div class="row" style="gap:14px;align-items:flex-end">
      <div><label>Comparative year to take</label>
        <select id="priorYearPick">${[yr, ...years.filter((y) => y !== yr)].filter(Boolean)
          .map((y) => `<option value="${y}"${y === yr ? ' selected' : ''}>year ended ${y}</option>`).join('')}</select></div>
      <div><label>Amounts in the document are in</label>
        <select id="priorUnitPick">${UNIT_OPTS.map(([v, lbl]) =>
          `<option value="${v}"${v === unitNow && v !== '' ? ' selected' : ''}>${esc(lbl)}</option>`).join('')}</select></div>
      <button class="btn ghost sm" id="priorReread" type="button">Re-read with these</button>
    </div>
    <div class="muted" style="margin-top:8px">`
    + (cols.length
        ? cols.map((c) => `<div>${esc(c.sheet)} → column <b>${esc(c.chosen.text)}</b> <span style="opacity:.75">(${esc(c.because)})</span></div>`).join('')
        : '<div>No sheet yielded a period column.</div>')
    + (units.length
        ? units.map((u) => `<div>${esc(u.sheet)} → read as <b>${esc(u.label)}</b>, multiplied by ${u.applied.toLocaleString('en-IN')} — from ${esc(u.source || 'your choice above')}</div>`).join('')
        : '<div>No units note found; amounts are taken as rupees.</div>')
    + '</div></div>';

  h += '<h4 style="margin:12px 0 4px;font-size:12px;color:var(--mut)">PARTICULARS</h4>';
  h += f.length ? `<table class="fin"><thead><tr><th>Field</th><th>Value read</th><th>Where it was found</th><th>Use?</th></tr></thead><tbody>`
    + f.map((x2, i) => `<tr><td>${esc(x2.label || x2.key)}</td>
        <td><input data-pf="${i}" value="${esc(x2.value)}" style="width:100%"></td>
        <td class="muted">${esc(x2.source)}</td>
        <td style="text-align:center"><input type="checkbox" data-pfu="${i}" checked></td></tr>`).join('')
    + '</tbody></table>' : '<p class="muted">No particulars could be read.</p>';

  // Split by statement, so a P&L that imported as nothing is obvious instead of
  // being buried in a long list of balance-sheet lines.
  const secOf = (id) => ((S.heads.find((hh) => hh.lineId === id) || {}).section || '');
  const PL_SECS = ['INCOME', 'EXPENSE', 'TAX', 'OCI'];
  const nPL = fig.filter((x2) => PL_SECS.includes(secOf(x2.lineId))).length;
  const nBS = fig.length - nPL;
  h += '<h4 style="margin:14px 0 4px;font-size:12px;color:var(--mut)">COMPARATIVE FIGURES</h4>';
  h += `<div class="chk ${nPL ? 'INFO' : 'REVIEW'}" style="margin-bottom:8px">
      ${nBS} from the balance sheet \u00b7 ${nPL} from the statement of profit and loss.
      ${nPL ? '' : ' No profit-and-loss comparative was read \u2014 check that the P&amp;L sheet has a \u201cParticulars\u201d heading with a period column.'}</div>`;
  if ((x.skippedSheets || []).length) h += '<div class="chk INFO" style="margin-bottom:8px">Sheets not read for figures: '
    + x.skippedSheets.map((s2) => `<b>${esc(s2.sheet)}</b> (${esc(s2.why)})`).join(' \u00b7 ') + '</div>';
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
  if ($('priorReread')) $('priorReread').onclick = reReadPrior;
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
    await loadComparatives();
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
    reach(8);
  } catch (e) { $('obsList').innerHTML = `<div class="chk CRITICAL">Could not build observations: ${esc(e.message)}</div>`; }
}

/* ---------- boot -------------------------------------------------------- */
loadConstitutions().then(loadEngagements);
