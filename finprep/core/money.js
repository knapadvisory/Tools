/* ============================================================================
 * money.js — exact monetary arithmetic
 *
 * Spec §6: "Calculate in exact decimal rupees or equivalent fixed precision.
 * Apply presentation scaling and rounding only at the reporting layer."
 * Spec §15: "Avoid monetary binary-floating-point arithmetic."
 *
 * Every amount in the engine is an INTEGER NUMBER OF PAISE. Floats never carry
 * a monetary value. Safe range is ±9,007,199,254,740,991 paise ≈ ±₹90,071 crore,
 * which comfortably covers any company this tool targets; anything beyond that
 * throws rather than silently losing precision.
 * ==========================================================================*/

export const PAISE = 100;
const MAX = Number.MAX_SAFE_INTEGER;

function guard(p, what) {
  if (!Number.isFinite(p) || !Number.isInteger(p)) {
    throw new TypeError(`money: ${what} must be an integer paise value, got ${p}`);
  }
  if (Math.abs(p) > MAX) throw new RangeError(`money: ${what} exceeds safe precision`);
  return p;
}

/** Parse a rupee value (number or string, with commas / ₹ / brackets) into paise. */
export function toPaise(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError('money: non-finite amount');
    // round half away from zero at the paisa, so 0.005 -> 0.01 and -0.005 -> -0.01
    const scaled = v * PAISE;
    return guard(Math.sign(scaled) * Math.round(Math.abs(scaled)), 'amount');
  }
  const t = String(v).trim();
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t);
  const cleaned = t.replace(/[()₹₹,\s]/g, '').replace(/^-/, '').replace(/\b(?:Rs\.?|INR)\b/gi, '');
  if (cleaned === '' || cleaned === '-') return 0;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) throw new TypeError(`money: cannot parse amount "${v}"`);
  const p = Math.sign(n) * Math.round(Math.abs(n) * PAISE);
  return guard(neg ? -Math.abs(p) : p, 'amount');
}

/** Paise -> rupees as a Number. ONLY for display/export; never feed back into maths. */
export function toRupees(p) { return guard(p, 'amount') / PAISE; }

export const add = (...xs) => guard(xs.reduce((t, x) => t + guard(x, 'operand'), 0), 'sum');
export const sub = (a, b) => guard(guard(a, 'operand') - guard(b, 'operand'), 'difference');
export const neg = (a) => guard(-guard(a, 'operand'), 'amount');
export const isZero = (a) => guard(a, 'operand') === 0;
export const sum = (xs) => add(...xs);

/**
 * Multiply paise by a ratio, rounding half away from zero.
 * Used for depreciation/tax rates, never for splitting a total (see allocate).
 */
export function mulRate(p, rate) {
  guard(p, 'amount');
  if (!Number.isFinite(rate)) throw new TypeError('money: non-finite rate');
  const r = p * rate;
  return guard(Math.sign(r) * Math.round(Math.abs(r)), 'amount');
}

/**
 * Split `total` across `weights` with the largest-remainder method so the parts
 * always add back to exactly `total` — no rounding plug, per spec §6.
 */
export function allocate(total, weights) {
  guard(total, 'amount');
  const w = weights.map(Number);
  const gross = w.reduce((t, x) => t + Math.abs(x), 0);
  if (gross === 0) return w.map(() => 0);
  const exact = w.map((x) => (total * x) / gross);
  const floors = exact.map((x) => Math.trunc(x));
  let rem = total - floors.reduce((t, x) => t + x, 0);
  const order = exact
    .map((x, i) => ({ i, frac: Math.abs(x - floors[i]) }))
    .sort((a, b) => b.frac - a.frac);
  const out = floors.slice();
  const step = rem >= 0 ? 1 : -1;
  for (let k = 0; rem !== 0 && k < order.length * 2; k++) {
    out[order[k % order.length].i] += step;
    rem -= step;
  }
  return out;
}

/** Indian-format display string, e.g. 12,34,567.89 — negatives in brackets. */
export function format(p, { brackets = true } = {}) {
  guard(p, 'amount');
  const negv = p < 0;
  const abs = Math.abs(p);
  const rupees = Math.trunc(abs / PAISE);
  const paise = String(abs % PAISE).padStart(2, '0');
  const s = rupees.toLocaleString('en-IN') + '.' + paise;
  if (!negv) return s;
  return brackets ? `(${s})` : `-${s}`;
}

/** Presentation scaling — reporting layer only (Schedule III General Instruction 4). */
export const SCALES = {
  full: { div: 1, label: 'Amounts in ₹' },
  hundreds: { div: 100, label: 'Amounts in ₹ hundreds' },
  thousands: { div: 1000, label: 'Amounts in ₹ thousands' },
  lakhs: { div: 100000, label: 'Amounts in ₹ lakhs' },
  millions: { div: 1000000, label: 'Amounts in ₹ millions' },
  crores: { div: 10000000, label: 'Amounts in ₹ crores' },
};

/**
 * Schedule III General Instruction 4 (as amended 2021) makes rounding MANDATORY
 * and ties the permitted units to turnover. Returns the allowed scale keys.
 */
export function permittedScales(turnoverPaise) {
  const cr = Math.abs(toRupees(turnoverPaise)) / 10000000;
  return cr < 100
    ? ['hundreds', 'thousands', 'lakhs', 'millions']
    : ['lakhs', 'millions', 'crores'];
}

export function scaled(p, scaleKey) {
  const s = SCALES[scaleKey] || SCALES.full;
  return toRupees(p) / s.div;
}
