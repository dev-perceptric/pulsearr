// The screen rules from docs/brand.md, checked on every file in src/components and src/app, so a screen can't drift
// back to its own colors, dialog shells, unnamed icon buttons, date formats, pills, rounded cards or card shadows.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function files(dir: string, ext = /\.tsx?$/): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p, ext) : ext.test(p) ? [p] : [];
  });
}

const app = [...files("src/components"), ...files("src/app")].filter((f) => f.endsWith(".tsx"));
// Every source file, styles included, for the brand-wide rules.
const everything = files("src", /\.(tsx?|css)$/);
const read = (f: string) => readFileSync(f, "utf8");
// Lines of code with comments taken out, so a rule can be explained in a comment without failing.
const code = (f: string) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"));

function scan(list: string[], bad: (line: string) => boolean) {
  const out: string[] = [];
  for (const f of list) code(f).forEach((l, i) => bad(l) && out.push(`${f}:${i + 1}: ${l.trim().slice(0, 120)}`));
  return out;
}

test("no raw colors in the app's screens", () => {
  // Logos and the empty-state drawings draw real colors on purpose.
  const allowed = /(BrandLogo|Logo|Drawing|Icons)\.tsx$/;
  const hits = scan(
    app.filter((f) => !allowed.test(f)),
    (l) => {
      const cls = [...l.matchAll(/className=\{?["`]([^"`]*)["`]/g)].map((m) => m[1]).join(" ");
      return /(^|[\s:])(text|bg|border|ring|fill|stroke|outline|accent|from|to|via|shadow|decoration)-(red|amber|green|blue|yellow|orange|emerald|rose|sky|indigo|purple|pink|lime|teal|cyan|violet|fuchsia|slate|zinc|neutral|stone|gray)-\d{2,3}\b/.test(cls) || /\[#[0-9a-fA-F]{3,8}\]/.test(cls) || /\[(rgb|rgba|hsl|hsla|oklch)\(/.test(cls);
    },
  );
  assert.deepEqual(hits, [], "use the color tokens from globals.css");
});

test('no "·" between words', () => {
  const hits = scan(app, (l) => l.includes("·"));
  assert.deepEqual(hits, [], "use line breaks, commas or separate cells");
});

test("dialogs and side sheets use Modal and Sheet", () => {
  // The shared ones and the question box draw their own layer.
  const own = /(Overlay|Dialogs)\.tsx$/;
  const hits = scan(
    app.filter((f) => !own.test(f)),
    (l) => /className=\{?["`][^"`]*\bfixed inset-0\b[^"`]*\bbg-scrim\b/.test(l) || /className=\{?["`][^"`]*\bbg-scrim\b[^"`]*\bfixed inset-0\b/.test(l),
  );
  assert.deepEqual(hits, [], "use Modal or Sheet from src/components/Overlay.tsx");
});

test("every icon-only button has a name", () => {
  const out: string[] = [];
  for (const f of app) {
    const s = read(f);
    let at = 0;
    while ((at = s.indexOf("<button", at)) !== -1) {
      // Walk to the end of the opening tag, skipping `>` inside {...} such as arrow functions.
      let i = at + 7;
      let depth = 0;
      for (; i < s.length; i++) {
        const c = s[i];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === ">" && depth === 0) break;
      }
      const attrs = s.slice(at, i);
      const end = s.indexOf("</button>", i);
      const inner = end === -1 ? "" : s.slice(i + 1, end).trim();
      // Only an icon inside: one self-closing component tag, like <X size={14} />.
      const iconOnly = /^<[A-Z][\w.]*(\s[^<>]*)?\/>$/.test(inner);
      if (!attrs.endsWith("/") && iconOnly && !/aria-label|title=|aria-labelledby/.test(attrs)) out.push(`${f}:${s.slice(0, at).split("\n").length}`);
      at = i;
    }
  }
  assert.deepEqual(out, [], "give it aria-label, or use IconButton");
});

test("Segmented switches a view, never a page's tabs", () => {
  const hits = scan(app, (l) => /<Segmented\b[^>]*onChange=\{\(?setTab\b/.test(l));
  assert.deepEqual(hits, [], "use TabNav with useAddressTab for tabs");
});

test("dates and numbers go through src/lib/format.ts", () => {
  const hits = scan(app, (l) => /\.toLocale(Date|Time)?String\(|new Intl\.(DateTimeFormat|NumberFormat)\(/.test(l));
  assert.deepEqual(hits, [], "use fmtDate, fmtTime, fmtDateTime, fmtNum, fmtMoney, fmtPercent or fmtChange");
});

test("no browser dropdowns or pop-ups", () => {
  const hits = scan(app, (l) => /<select\b|window\.(confirm|prompt|alert)\(|(^|[^.\w])(confirm|prompt|alert)\(["'`]/.test(l));
  assert.deepEqual(hits, [], "use Select and askConfirm, askText or tell");
});

test('never the words "Loading…"', () => {
  const hits = scan(app, (l) => /["'>`]\s*Loading(…|\.\.\.)/.test(l));
  assert.deepEqual(hits, [], "use Loader or Loading");
});

// In current Chrome, scrollIntoView and the other scroll methods return a promise. An effect written as
// `useEffect(() => el.scrollIntoView(...))` hands that promise to React as its clean-up, and the page crashes with
// "destroy is not a function" the next time the effect runs. Effects keep a body in braces.
test("no effect returns what a call returns, like a scroll", () => {
  const bad = app.flatMap((f) => read(f).split("\n").map((l, i) => [f, i + 1, l] as const)).filter(([, , l]) => /use(Layout)?Effect\(\(\) => (?!\{|\(\)|clear\b)[\w.?]+\(/.test(l));
  assert.deepEqual(
    bad.map(([f, n]) => `${f}:${n}`),
    [],
  );
});

// Text is never cut off: it wraps and the layout makes room (docs/brand.md section 5). Every file in src.
test("never hide text: no truncate, line clamps or ellipsis", () => {
  const bad = /(?<![\w-])truncate(?![\w-])|(?<![\w-])line-clamp-|(?<![\w-])text-ellipsis(?![\w-])|textOverflow|text-overflow\s*:\s*ellipsis/;
  const hits = everything.flatMap((f) => read(f).split("\n").flatMap((l, i) => (bad.test(l) ? [`${f}:${i + 1}: ${l.trim().slice(0, 120)}`] : [])));
  assert.deepEqual(hits, [], "let the text wrap (wrap-anywhere, wrap-break-word) and give it room");
});

// No pills (docs/brand.md section 7): buttons, inputs, menus and segments use rounded-md, tags rounded-xs. The one
// round thing is the 8px status dot, so `rounded-full` may only sit in the same class list as an 8px size (`size-2`,
// or `h-2` with `w-2`). Every .ts and .tsx file in src.
test("no pills: rounded-full only on the 8px status dot", () => {
  const ts = everything.filter((f) => /\.tsx?$/.test(f));
  const hits = scan(ts, (l) => {
    if (!/(?<![\w-])rounded-full(?![\w-])/.test(l)) return false;
    const lists = [...l.matchAll(/["`]([^"`]*)["`]/g)].map((m) => m[1]).filter((c) => /(?<![\w-])rounded-full(?![\w-])/.test(c));
    const dot = (c: string) => /(?<![\w-])size-2(?![\w.-])/.test(c) || (/(?<![\w-])h-2(?![\w.-])/.test(c) && /(?<![\w-])w-2(?![\w.-])/.test(c));
    return lists.length === 0 || !lists.every(dot);
  });
  assert.deepEqual(hits, [], "use rounded-md for controls and rounded-xs for tags; only the 8px status dot (size-2) is round");
});

// Cards, panels, sheets and tables are square; controls, menus and dialogs are rounded-md (8px).
test("no rounded cards: no rounded-lg, -xl, -2xl or -3xl", () => {
  const hits = scan(everything, (l) => /(?<![\w-])rounded(-[trblse]{1,2})?-(lg|xl|2xl|3xl)(?![\w-])/.test(l));
  assert.deepEqual(hits, [], "cards are square (no radius class); controls, menus and dialogs use rounded-md");
});

// Depth comes from navy against white and paper against white. Only floating layers cast a shadow.
test("no card shadows: only shadow-pop, shadow-modal and shadow-focus", () => {
  const old = scan(everything, (l) => /(?<![\w-])shadow-(card|chip|hover|picked|outline|primary|green|pill|input|float|stick)(?![\w-])/.test(l));
  assert.deepEqual(old, [], "cards get a 1px border-line, never a shadow");
  const ts = everything.filter((f) => /\.tsx?$/.test(f));
  const other = scan(ts, (l) => [...l.matchAll(/(?<![\w-])shadow-([\w[\]-]+)/g)].some((m) => !/^(pop|modal|focus|none)$/.test(m[1])));
  assert.deepEqual(other, [], "only floating layers have a shadow: shadow-pop (menus, tooltips) or shadow-modal (dialogs, sheets)");
});

// Omniscient's green signal tokens never came across: pulse blue is the one accent.
test("no signal- tokens anywhere", () => {
  const hits = everything.flatMap((f) => read(f).split("\n").flatMap((l, i) => (/(?<![\w])signal-/.test(l) ? [`${f}:${i + 1}: ${l.trim().slice(0, 120)}`] : [])));
  assert.deepEqual(hits, [], "use brand, brand-soft and the other PulseARR tokens");
});
