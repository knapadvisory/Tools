/* ============================================================================
 * aiMap.js — ask a language model which head a ledger belongs to
 *
 * The rules in classify.js place most ledgers. For the rest — a ledger named
 * after a person, a product, an abbreviation only the client understands —
 * a model reading the NAME and the Tally GROUP can usually say which head it
 * is, and say why. That is all it is given: the ledger name and the group
 * path. No amounts, no party details, no GSTIN, nothing about the client but
 * its constitution. The preparer's own key is used, from their own browser,
 * and every answer comes back as a PROPOSAL to approve, never as a fact.
 *
 * Providers: Anthropic (direct from the browser with the user's key), any
 * OpenAI-compatible endpoint (Groq, OpenRouter, LM Studio…) and a local
 * Ollama. The model is asked for JSON only; anything that is not a known head
 * id is discarded, so a hallucinated head can never reach the chart.
 *
 * No DOM here: `suggest()` takes a fetch function, so it is testable in Node.
 * ==========================================================================*/

export const DEFAULT_MODELS = { anthropic: 'claude-haiku-4-5-20251001', openai: 'llama-3.1-8b-instant', ollama: 'llama3.1' };
export const CONFIG_KEY = 'knap-as-cfg';      // shared with the in-tool assistant, so one key serves both

/** The instruction the model receives. Short, strict, JSON out. */
export function buildPrompt({ ledgers, heads, constitution, framework }) {
  const chart = heads.map((h) => `${h.lineId} = ${h.caption}${h.sectionTitle ? ` [${h.sectionTitle}]` : ''}`).join('\n');
  const rows = ledgers.map((l, i) => `${i + 1}. "${l.name}"  under: ${(l.path && l.path.length ? l.path : [l.group]).filter(Boolean).join(' > ') || '(no group)'}`).join('\n');
  const who = constitution === 'company' ? 'an Indian company (Schedule III)'
    : `an Indian ${constitution === 'proprietorship' ? 'sole proprietorship' : constitution === 'llp' ? 'LLP' : constitution === 'huf' ? 'HUF' : constitution === 'partnership' ? 'partnership firm' : 'non-corporate entity'} (ICAI non-corporate format)`;
  return `You classify ledgers from an Indian accounting trial balance into financial-statement heads for ${who}${framework ? ' — ' + framework : ''}.

Heads (use the id on the left, exactly):
${chart}

Rules:
- Judge from the ledger NAME and the Tally GROUP it sits under. The group usually decides the statement; the name decides the head within it.
- A ledger under Capital Account in a firm or proprietorship is the owner's capital; a partner's remuneration or interest on capital is an appropriation head, not an employee or finance cost.
- Bank charges, interest on TDS/GST, penalties are other expenses, not finance costs. Advance tax and TDS receivable are current assets, not statutory dues.
- If you are not reasonably sure, say "unclassified" with low confidence rather than guess.

Ledgers:
${rows}

Answer with a JSON array only, one object per ledger in the same order: {"n": <number>, "lineId": "<head id>", "confidence": "high"|"medium"|"low", "why": "<one short phrase>"}. No prose before or after the JSON.`;
}

/** Pull the JSON array out of a model reply that may have wrapped it in prose or fences. */
export function parseReply(text) {
  const s = String(text || '');
  const start = s.indexOf('['), end = s.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try { const v = JSON.parse(s.slice(start, end + 1)); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** Keep only answers that name a known head, matched back to the ledger they are for. */
export function validate(answers, ledgers, heads) {
  const known = new Set(heads.map((h) => h.lineId));
  const out = [];
  for (const a of answers || []) {
    const n = Number(a && a.n);
    const led = Number.isInteger(n) && n >= 1 && n <= ledgers.length ? ledgers[n - 1] : null;
    if (!led) continue;
    const lineId = String((a && a.lineId) || '').trim();
    if (!known.has(lineId) || lineId === 'unclassified') continue;
    const conf = ['high', 'medium', 'low'].includes(a.confidence) ? a.confidence : 'low';
    out.push({ name: led.name, lineId, confidence: conf, why: String(a.why || '').slice(0, 160) });
  }
  return out;
}

/** One request to the chosen provider; returns the reply text. */
export async function callModel(cfg, prompt, fetchFn = fetch) {
  const provider = cfg.provider || 'anthropic';
  const model = cfg.model || DEFAULT_MODELS[provider];
  const timeout = (ms) => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; };
  if (provider === 'anthropic') {
    if (!cfg.apiKey) throw new Error('an Anthropic API key is needed (console.anthropic.com) — it is kept only in this browser');
    const r = await fetchFn('https://api.anthropic.com/v1/messages', { method: 'POST', signal: timeout(90000),
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model, max_tokens: 4000, temperature: 0, messages: [{ role: 'user', content: prompt }] }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    return (j.content || []).map((c) => c.text || '').join('');
  }
  if (provider === 'ollama') {
    const base = (cfg.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
    const r = await fetchFn(base + '/api/generate', { method: 'POST', signal: timeout(180000), headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0 } }) });
    if (!r.ok) throw new Error('Ollama HTTP ' + r.status + ' — is it running, started with OLLAMA_ORIGINS=*?');
    const j = await r.json();
    return j.response || '';
  }
  // OpenAI-compatible
  const base = (cfg.baseUrl || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  const hdr = { 'content-type': 'application/json' };
  if (cfg.apiKey) hdr.authorization = 'Bearer ' + cfg.apiKey;
  const r = await fetchFn(base + '/chat/completions', { method: 'POST', signal: timeout(90000), headers: hdr,
    body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'user', content: prompt }] }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && (j.error.message || j.error)) || ('HTTP ' + r.status));
  return (((j.choices || [])[0] || {}).message || {}).content || '';
}

/**
 * Suggest heads for `ledgers` ([{name, group, path}]) in batches.
 * Returns { suggestions: [{name, lineId, confidence, why}], batches, sent: { fields } }.
 */
export async function suggest(cfg, { ledgers, heads, constitution, framework }, { fetchFn = fetch, batchSize = 60, onProgress } = {}) {
  const usable = heads.filter((h) => h.lineId !== 'unclassified');
  const out = [];
  let batches = 0;
  for (let i = 0; i < ledgers.length; i += batchSize) {
    const slice = ledgers.slice(i, i + batchSize).map((l) => ({ name: l.name, group: l.group || '', path: l.path || l.groupPath || [] }));
    const prompt = buildPrompt({ ledgers: slice, heads: usable, constitution, framework });
    const reply = await callModel(cfg, prompt, fetchFn);
    out.push(...validate(parseReply(reply), slice, usable));
    batches += 1;
    if (onProgress) onProgress(Math.min(ledgers.length, i + batchSize), ledgers.length);
  }
  return { suggestions: out, batches, sent: { fields: ['ledger name', 'Tally group path'], never: ['amounts', 'GSTIN', 'party details', 'client name'] } };
}
