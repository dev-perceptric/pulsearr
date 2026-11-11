// What it costs to run PulseARR. Change PRICES or USAGE, then run: npm run costs
// Prices are US dollars, November 2026. Every price with check: true could not be confirmed on the vendor's own page.
// Totals are monthly, at Beta (50 teams) and Growth (500 teams). docs/costs.md holds the latest output.

export const PRICES = {
  // Hostinger VPS, per month. Beta shares the KVM 2 the other apps already pay for, so PulseARR adds nothing.
  // Before Growth PulseARR moves to its own KVM 4 (4 CPUs, 16 GB) at the renewal price.
  vps: { sharedKvm2: { price: 0 }, kvm4: { price: 12.99, check: true } },
  // Backblaze B2, per GB stored per month. The 10 GB free tier is account-wide and already used by the other apps'
  // backups, so it isn't counted.
  b2PerGB: { price: 0.006, check: true },
  // pulsearr.com at Namecheap, per year at renewal.
  domainPerYear: { price: 20, check: true },
  // Resend, per month. M0's sign-in and invite emails fit inside the plan the other apps already pay for. From M3
  // PulseARR has its own: Pro covers 50,000 emails, Scale 100,000, then about $0.90 per 1,000 more.
  resend: { pro: { price: 20, emails: 50000, check: true }, scale: { price: 90, emails: 100000, check: true }, extraPer1000: { price: 0.9, check: true } },
  // Twilio, per text to a US number (one segment), before carrier fees.
  twilioSms: { price: 0.0083, check: true },
  // Claude, per million tokens (the same prices as Omniscient's model).
  sonnet: { in: 2.0, out: 10.0, cacheRead: 0.2 }, // claude-sonnet-5-5
  haiku: { in: 0.1, out: 0.5, cacheRead: 0.01, check: true }, // claude-haiku-5-5
  // PostHog Cloud (US) product analytics: 1M events a month free, then $0.00005 each up to 2M and $0.0000343 up to 15M.
  posthogEvents: { tiers: [[1e6, 0], [2e6, 0.00005], [15e6, 0.0000343]], check: true },
  // Currency rates API: the free tier covers one daily pull at Beta; a paid plan for hourly pulls at Growth.
  fx: { free: 0, paid: { price: 10, check: true } },
  // Stripe's fee on PulseARR's own subscriptions (standard US card rate). Shown for the margin, not in the total.
  stripe: { pct: 0.029, fixed: 0.3, check: true },
};

// What one team does in a month. Token counts include thinking.
export const USAGE = {
  briefs: { count: 30, model: "haiku", in: 12000, out: 1500 }, // morning brief: the day's movements in, 3-5 lines out
  ask: { count: 40, model: "sonnet", in: 20000, out: 1200, cached: 0.6 }, // write SQL, read the rows, answer; schema cached
  alertReasons: { count: 4, model: "haiku", in: 6000, out: 600 },
  cancelSummaries: { count: 4, model: "sonnet", in: 8000, out: 800 }, // weekly summary of written cancel answers
  matchingHelp: { count: 20, model: "haiku", in: 3000, out: 300 }, // M7: unsure CRM matches checked by Claude
  forecastNotes: { count: 4, model: "sonnet", in: 10000, out: 1000 }, // M9
  emails: 400, // reports, Recover, cancel follow-ups
  smsShare: 0.5, // half of teams turn SMS on
  sms: 80, // per team with SMS on
  posthogEventsM0: 500, // sign-in, settings
  posthogEvents: 4000, // once the metric screens exist (M1)
  backupGB: { beta: 1, growth: 20 }, // B2: 90 days of nightly dumps
};

export const STAGES = [
  { name: "Beta", teams: 50 },
  { name: "Growth", teams: 500 },
];

// Average plan price at Growth: 60% Starter $29, 30% Growth $79, 10% Scale $199 (docs/build-plan.md section 4).
export const ARPA = 0.6 * 29 + 0.3 * 79 + 0.1 * 199;

const isBeta = (teams) => teams <= 50;

export function call({ model, in: inTok, out: outTok, cached = 0 }) {
  const p = PRICES[model];
  return (inTok * (1 - cached) * p.in + inTok * cached * p.cacheRead + outTok * p.out) / 1e6;
}

const tiers = (n, steps) => {
  let cost = 0;
  let from = 0;
  for (const [upTo, each] of steps) {
    cost += Math.max(0, Math.min(n, upTo) - from) * each;
    from = upTo;
  }
  return cost;
};

export function resendMonthly(emails) {
  const r = PRICES.resend;
  if (emails <= r.pro.emails) return r.pro.price;
  return r.scale.price + Math.max(0, Math.ceil((emails - r.scale.emails) / 1000)) * r.extraPer1000.price;
}

const claude = (job) => (teams) => teams * job.count * call(job);
const u = USAGE;

// Each milestone's lines: [label, (teams) => monthly dollars, check]. A line marked check uses a price marked check.
export const MILESTONES = [
  {
    name: "M0 Foundation",
    lines: [
      ["Server: shared KVM 2 at Beta, own KVM 4 at Growth", (t) => (isBeta(t) ? PRICES.vps.sharedKvm2.price : PRICES.vps.kvm4.price), true],
      ["Backups on Backblaze B2", (t) => (isBeta(t) ? u.backupGB.beta : u.backupGB.growth) * PRICES.b2PerGB.price, true],
      ["Resend (inside the plan the other apps use)", () => 0, true],
      ["PostHog (sign-in and settings events)", (t) => tiers(t * u.posthogEventsM0, PRICES.posthogEvents.tiers), true],
      ["Claude (nothing calls it in M0)", () => 0, false],
      ["Domain pulsearr.com", () => PRICES.domainPerYear.price / 12, true],
    ],
  },
  {
    name: "M1 Stripe metrics core",
    lines: [
      ["PostHog (metric screens, beyond M0's events)", (t) => tiers(t * u.posthogEvents, PRICES.posthogEvents.tiers) - tiers(t * u.posthogEventsM0, PRICES.posthogEvents.tiers), true],
      ["Currency rates API", (t) => (isBeta(t) ? PRICES.fx.free : PRICES.fx.paid.price), true],
    ],
  },
  { name: "M2 Customers and segments", lines: [] },
  { name: "M3 Reports and alerts", lines: [["Resend, PulseARR's own plan (400 emails a team)", (t) => resendMonthly(t * u.emails), true]] },
  {
    name: "M4 Pulse AI analyst",
    lines: [
      ["Claude: morning briefs on Haiku", claude(u.briefs), true],
      ["Claude: Ask on Sonnet", claude(u.ask), false],
      ["Claude: alert reasons on Haiku", claude(u.alertReasons), true],
    ],
  },
  { name: "M5 Recover", lines: [["Twilio SMS (half of teams, 80 texts each)", (t) => t * u.smsShare * u.sms * PRICES.twilioSms.price, true]] },
  { name: "M6 Cancel flow", lines: [["Claude: cancel summaries on Sonnet", claude(u.cancelSummaries), false]] },
  { name: "M7 Revenue by source", lines: [["Claude: matching help on Haiku", claude(u.matchingHelp), true]] },
  { name: "M8 More billing sources", lines: [] },
  { name: "M9 Forecast and Benchmarks", lines: [["Claude: forecast notes on Sonnet", claude(u.forecastNotes), false]] },
];

export const sum = (lines, teams) => lines.reduce((a, [, f]) => a + f(teams), 0);
export const milestoneCost = (m, teams) => sum(m.lines, teams);
export const totalCost = (teams) => MILESTONES.reduce((a, m) => a + milestoneCost(m, teams), 0);
// The docs round each line up to the next dollar.
const up = (n) => Math.max(0, Math.ceil(n - 1e-9));
export const roundedUp = (lines, teams) => lines.reduce((a, [, f]) => a + up(f(teams)), 0);

const usd = (n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const whole = (n) => `$${up(n).toLocaleString("en-US")}`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const [beta, growth] = STAGES;
  const head = (label) => console.log(`\n${label.padEnd(62)} ${beta.name.padStart(16)} ${growth.name.padStart(16)}`);
  const row = (label, b, g, check) => console.log(`  ${(label + (check ? " (check)" : "")).padEnd(60)} ${b.padStart(16)} ${g.padStart(16)}`);

  console.log(`PulseARR running cost per month. ${beta.name} ${beta.teams} teams, ${growth.name} ${growth.teams} teams.`);
  console.log("Lines marked (check) use a price that couldn't be confirmed on the vendor's own page.");

  const m0 = MILESTONES[0];
  head("M0 Foundation, line by line (exact, then rounded up)");
  for (const [label, f, check] of m0.lines) row(label, `${usd(f(beta.teams))} ${whole(f(beta.teams))}`, `${usd(f(growth.teams))} ${whole(f(growth.teams))}`, check);
  row("M0 total (lines rounded up)", whole(roundedUp(m0.lines, beta.teams)), whole(roundedUp(m0.lines, growth.teams)));

  head("What each milestone adds");
  let runB = 0;
  let runG = 0;
  for (const m of MILESTONES) {
    const b = milestoneCost(m, beta.teams);
    const g = milestoneCost(m, growth.teams);
    runB += b;
    runG += g;
    row(m.name, usd(b), usd(g));
    if (m !== m0) for (const [label, f, check] of m.lines) row(`  ${label}`, usd(f(beta.teams)), usd(f(growth.teams)), check);
  }

  head("All lines, every milestone shipped");
  const all = MILESTONES.flatMap((m) => m.lines);
  for (const [label, f, check] of all) row(label, usd(f(beta.teams)), usd(f(growth.teams)), check);
  row("Total", usd(runB), usd(runG));
  row("Total (lines rounded up)", whole(roundedUp(all, beta.teams)), whole(roundedUp(all, growth.teams)));

  console.log("\nCost of each AI action");
  for (const [name, job] of Object.entries({ "Morning brief": u.briefs, "Ask question": u.ask, "Alert reason": u.alertReasons, "Cancel summary": u.cancelSummaries, "Matching help": u.matchingHelp, "Forecast note": u.forecastNotes })) {
    console.log(`  ${`${name} (${job.model})`.padEnd(60)} $${call(job).toFixed(4)}`);
  }

  const revenue = growth.teams * ARPA;
  const fees = growth.teams * (ARPA * PRICES.stripe.pct + PRICES.stripe.fixed);
  console.log(`\nMargin at Growth: revenue ${usd(revenue)} (average ${usd(ARPA)} a team), running cost ${usd(runG)}, Stripe fees on our own plans ${usd(fees)} (check).`);
}
