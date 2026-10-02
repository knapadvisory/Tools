/* AI head suggestions: the prompt carries names and groups only, the reply is
 * validated against the chart, and every provider shape is handled.
 * Run: node finprep/core/aiMap.test.mjs                                     */
import assert from 'node:assert/strict';
import { buildPrompt, parseReply, validate, suggest } from './aiMap.js';
import { linesFor, captionFor } from './schedule3.js';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + e.message); }
}
const heads = linesFor('NCE').map((l) => ({ lineId: l.id, caption: captionFor(l.id, 'NCE', 'partnership'), sectionTitle: l.section }));
const ledgers = [
  { name: 'Ramesh Capital A/c', group: 'Capital Account', path: ['Capital Account'], current: 560000, gstin: '27AAAPX1234A1Z5' },
  { name: 'Mahavir Traders', group: 'Sundry Creditors', path: ['Sundry Creditors', 'Current Liabilities'], current: -100000 },
  { name: 'XYZ', group: 'Indirect Expenses', path: ['Indirect Expenses'], current: 5000 },
];

await t('the prompt carries ledger names and groups, and nothing else about the books', async () => {
  const p = buildPrompt({ ledgers, heads, constitution: 'partnership' });
  assert.match(p, /"Ramesh Capital A\/c"  under: Capital Account/);
  assert.match(p, /Sundry Creditors > Current Liabilities/);
  assert.ok(!/560000|5,60,000|27AAAPX/.test(p), 'amounts and GSTINs never leave the machine');
  assert.match(p, /owners_capital = Partners’ capital accounts/);
  assert.match(p, /partnership firm/);
  assert.match(p, /JSON array only/);
});
await t('a reply wrapped in prose or fences still parses', async () => {
  const r = parseReply('Sure! Here it is:\n```json\n[{"n":1,"lineId":"owners_capital","confidence":"high","why":"capital"}]\n```\nHope that helps.');
  assert.equal(r.length, 1); assert.equal(r[0].lineId, 'owners_capital');
  assert.deepEqual(parseReply('no json here'), []);
  assert.deepEqual(parseReply('[not valid'), []);
});
await t('an unknown head, an out-of-range number, or "unclassified" is discarded; confidence is normalised', async () => {
  const v = validate([
    { n: 1, lineId: 'owners_capital', confidence: 'high', why: 'capital' },
    { n: 2, lineId: 'made_up_head', confidence: 'high' },
    { n: 2, lineId: 'trade_payables_others', confidence: 'certain', why: 'creditor' },
    { n: 3, lineId: 'unclassified', confidence: 'low' },
    { n: 9, lineId: 'other_expenses' },
    { lineId: 'other_expenses' },
  ], ledgers, heads);
  assert.deepEqual(v.map((x) => [x.name, x.lineId, x.confidence]),
    [['Ramesh Capital A/c', 'owners_capital', 'high'], ['Mahavir Traders', 'trade_payables_others', 'low']]);
});
await t('suggest() batches, calls the provider with the key, and returns only validated proposals', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    const body = JSON.parse(init.body);
    const prompt = body.messages[0].content;
    const n = (prompt.match(/^\d+\. "/gm) || []).length;
    const answers = Array.from({ length: n }, (_, i) => ({ n: i + 1, lineId: i % 2 ? 'trade_payables_others' : 'other_expenses', confidence: 'medium', why: 'test' }));
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(answers) }] }) };
  };
  const many = Array.from({ length: 130 }, (_, i) => ({ name: 'L' + i, group: 'Indirect Expenses', path: ['Indirect Expenses'] }));
  const res = await suggest({ provider: 'anthropic', apiKey: 'sk-test' }, { ledgers: many, heads, constitution: 'partnership' }, { fetchFn, batchSize: 60 });
  assert.equal(res.batches, 3);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].init.headers['x-api-key'], 'sk-test');
  assert.equal(res.suggestions.length, 130);
  assert.equal(res.suggestions[1].lineId, 'trade_payables_others');
  assert.deepEqual(res.sent.never, ['amounts', 'GSTIN', 'party details', 'client name']);
});
await t('an OpenAI-compatible endpoint and Ollama are read correctly, and an error surfaces', async () => {
  const oa = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '[{"n":1,"lineId":"owners_capital","confidence":"high"}]' } }] }) });
  const r1 = await suggest({ provider: 'openai', apiKey: 'k', baseUrl: 'https://x/v1' }, { ledgers: ledgers.slice(0, 1), heads, constitution: 'partnership' }, { fetchFn: oa });
  assert.equal(r1.suggestions[0].lineId, 'owners_capital');
  const ol = async () => ({ ok: true, status: 200, json: async () => ({ response: '[{"n":1,"lineId":"owners_capital","confidence":"high"}]' }) });
  const r2 = await suggest({ provider: 'ollama' }, { ledgers: ledgers.slice(0, 1), heads, constitution: 'partnership' }, { fetchFn: ol });
  assert.equal(r2.suggestions.length, 1);
  const bad = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid x-api-key' } }) });
  await assert.rejects(() => suggest({ provider: 'anthropic', apiKey: 'nope' }, { ledgers, heads, constitution: 'partnership' }, { fetchFn: bad }), /invalid x-api-key/);
  await assert.rejects(() => suggest({ provider: 'anthropic' }, { ledgers, heads, constitution: 'partnership' }, { fetchFn: bad }), /API key is needed/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
