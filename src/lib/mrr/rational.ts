// Exact fractions over BigInt, so MRR never drifts: an annual $100 plan is 10000/12 cents a month, kept as that
// fraction until the one rounding at the end. Sums are exact, so the order things are added in can't change a cent.

export type Q = { readonly n: bigint; readonly d: bigint };

const abs = (x: bigint) => (x < 0n ? -x : x);

function gcd(a: bigint, b: bigint): bigint {
  a = abs(a);
  b = abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

function big(x: bigint | number): bigint {
  if (typeof x === "bigint") return x;
  if (!Number.isSafeInteger(x)) throw new RangeError(`Not a whole number: ${x}`);
  return BigInt(x);
}

/** n/d, reduced, with a positive denominator. */
export function q(n: bigint | number, d: bigint | number = 1n): Q {
  let nn = big(n);
  let dd = big(d);
  if (dd === 0n) throw new RangeError("Division by zero");
  if (dd < 0n) {
    nn = -nn;
    dd = -dd;
  }
  const g = gcd(nn, dd) || 1n;
  return { n: nn / g, d: dd / g };
}

export const ZERO: Q = q(0n);
export const ONE: Q = q(1n);

export const add = (a: Q, b: Q): Q => q(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Q, b: Q): Q => q(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Q, b: Q): Q => q(a.n * b.n, a.d * b.d);
export const div = (a: Q, b: Q): Q => q(a.n * b.d, a.d * b.n);
export const cmp = (a: Q, b: Q): number => {
  const x = a.n * b.d - b.n * a.d;
  return x < 0n ? -1 : x > 0n ? 1 : 0;
};
export const eq = (a: Q, b: Q) => a.n === b.n && a.d === b.d;
export const isZero = (a: Q) => a.n === 0n;
export const absQ = (a: Q): Q => (a.n < 0n ? q(-a.n, a.d) : a);
export const sum = (xs: Q[]): Q => xs.reduce(add, ZERO);

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/** A decimal string or number ("1.0870", 3000, "0.5", "1e-3") as an exact fraction. */
export function decimal(v: string | number): Q {
  const s = typeof v === "number" ? String(v) : v.trim();
  const m = DECIMAL.exec(s);
  if (!m || (!m[2] && !m[3])) throw new RangeError(`Not a decimal: ${JSON.stringify(v)}`);
  const frac = m[3] ?? "";
  const exp = Number(m[4] ?? 0) - frac.length;
  let n = BigInt((m[2] || "0") + frac);
  if (m[1] === "-") n = -n;
  return exp >= 0 ? q(n * 10n ** BigInt(exp)) : q(n, 10n ** BigInt(-exp));
}

/** Round to a whole number, half away from zero: 2.5 is 3, −2.5 is −3. */
export function roundHalfAway(x: Q): bigint {
  const r = (2n * abs(x.n) + x.d) / (2n * x.d);
  return x.n < 0n ? -r : r;
}

/** `places` decimals, half away from zero, without trailing zeros: 1.08700 is "1.087", 1 is "1". */
export function toDecimalText(x: Q, places = 10): string {
  const scale = 10n ** BigInt(places);
  const r = roundHalfAway(mul(x, q(scale)));
  const neg = r < 0n;
  const digits = abs(r).toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const fracPart = digits.slice(digits.length - places).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${fracPart ? `.${fracPart}` : ""}`;
}

/** A bigint as a JS number, refusing anything past 2^53. */
export function toNumber(x: bigint): number {
  const n = Number(x);
  if (!Number.isSafeInteger(n)) throw new RangeError(`Too large: ${x}`);
  return n;
}
