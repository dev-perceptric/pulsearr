// The European Central Bank's free daily reference rates (docs/m1-plan.md section 4: fx_rates). Each rate is how
// much of a currency 1 euro buys on a business day. Node runs this file directly (the worker's fx.load).

export const ECB_DAILY = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
export const ECB_90_DAYS = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";
/** Every business day since 1999 (about 8 MB). */
export const ECB_HISTORY = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml";

export type EcbRate = { day: string; quote: string; rate: string };

/** Every (day, currency, rate) in an ECB eurofxref file. Quotes are lowercase; rates stay exact text. */
export function parseEcb(xml: string): EcbRate[] {
  const out: EcbRate[] = [];
  const days = /<Cube\s+time\s*=\s*['"](\d{4}-\d{2}-\d{2})['"]\s*>([\s\S]*?)<\/Cube>/g;
  for (const d of xml.matchAll(days)) {
    const day = d[1]!;
    for (const r of d[2]!.matchAll(/<Cube\s+currency\s*=\s*['"]([A-Z]{3})['"]\s+rate\s*=\s*['"]([0-9]+(?:\.[0-9]+)?)['"]\s*\/>/g)) {
      if (r[1] === "EUR" || Number(r[2]) <= 0) continue;
      out.push({ day, quote: r[1]!.toLowerCase(), rate: r[2]! });
    }
  }
  return out;
}
