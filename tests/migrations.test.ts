// Migration rules (docs/m0-plan.md 3.4). The VPS runner applies each file in supabase/migrations once, in order,
// inside one transaction, and records it in ops.schema_migrations. So every file must be numbered 001..N with no
// gaps or duplicates, must not manage its own transaction or use statements that can't run inside one, and must be
// safe to run twice. `npm run test:db` proves the last part on a real database; this catches it without one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dirname, "..", "supabase", "migrations");

/** SQL without comments or the insides of string literals, so a word in a comment or message can't trip a rule. */
function code(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

const unquote = (name: string) => name.replace(/"/g, "").replace(/^public\./i, "").toLowerCase();

/** Every rule a set of migration files breaks, as short lines. */
export function problems(files: { name: string; sql: string }[]): string[] {
  const out: string[] = [];
  const numbers = new Map<number, string[]>();
  for (const f of files) {
    const m = /^(\d{3})_[a-z0-9_]+\.sql$/.exec(f.name);
    if (!m) {
      out.push(`${f.name}: name must look like 001_name.sql (lowercase, three digits)`);
      continue;
    }
    const n = Number(m[1]);
    numbers.set(n, [...(numbers.get(n) ?? []), f.name]);
  }
  for (const [n, names] of numbers) if (names.length > 1) out.push(`number ${String(n).padStart(3, "0")} is used twice: ${names.join(", ")}`);
  const max = Math.max(0, ...numbers.keys());
  for (let n = 1; n <= max; n++) if (!numbers.has(n)) out.push(`number ${String(n).padStart(3, "0")} is missing`);

  for (const f of files) {
    const sql = code(f.sql);
    const bad = (rule: string) => out.push(`${f.name}: ${rule}`);
    // Outside function and DO bodies, where plpgsql's own begin/end blocks live.
    const top = sql.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, " ");
    if (/\b(begin|start\s+transaction)\s*(transaction|work)?\s*;/i.test(top)) bad("starts its own transaction (the runner wraps each file in one)");
    if (/\b(commit|rollback|abort)\s*(transaction|work|and\s+chain)?\s*;|\bend\s+(transaction|work)\s*;/i.test(top)) {
      bad("ends a transaction (the runner wraps each file in one)");
    }
    if (/\bconcurrently\b/i.test(sql)) bad("uses CONCURRENTLY, which can't run inside a transaction");
    if (/\bvacuum\b/i.test(sql)) bad("uses VACUUM, which can't run inside a transaction");
    for (const m of sql.matchAll(/\bcreate\s+(?:(?:global|local)\s+)?(?:temp(?:orary)?\s+|unlogged\s+)?table\s+(?!if\s+not\s+exists\b)([\w."]+)/gi)) {
      bad(`create table ${m[1]} needs "if not exists"`);
    }
    for (const m of sql.matchAll(/\bcreate\s+(?:unique\s+)?index\s+(?!if\s+not\s+exists\b)([\w."]+)/gi)) bad(`create index ${m[1]} needs "if not exists"`);
    for (const m of sql.matchAll(/\bcreate\s+(schema|extension|sequence)\s+(?!if\s+not\s+exists\b)([\w."]+)/gi)) bad(`create ${m[1]} ${m[2]} needs "if not exists"`);
    for (const m of sql.matchAll(/\bcreate\s+(function|procedure|view|trigger)\s+([\w."]+)/gi)) bad(`create ${m[1]} ${m[2]} needs "or replace"`);
    // Every policy is dropped (if it exists) earlier in the same file, on the same table.
    const policySql = f.sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
    const drops: { at: number; key: string }[] = [];
    for (const m of policySql.matchAll(/\bdrop\s+policy\s+if\s+exists\s+("[^"]+"|\w+)\s+on\s+([\w."]+)/gi)) {
      drops.push({ at: m.index ?? 0, key: `${unquote(m[1])} on ${unquote(m[2])}` });
    }
    for (const m of policySql.matchAll(/\bcreate\s+policy\s+("[^"]+"|\w+)\s+on\s+([\w."]+)/gi)) {
      const key = `${unquote(m[1])} on ${unquote(m[2])}`;
      if (!drops.some((d) => d.key === key && d.at < (m.index ?? 0))) bad(`create policy ${key} needs "drop policy if exists" before it`);
    }
  }
  return out;
}

function migrations() {
  return readdirSync(DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(DIR, name), "utf8") }));
}

test("migrations follow the rules", () => {
  const files = migrations();
  assert.ok(files.length > 0, "no migrations found");
  assert.deepEqual(problems(files), []);
});

test("only .sql files sit in supabase/migrations", () => {
  const other = readdirSync(DIR).filter((name) => !name.endsWith(".sql"));
  assert.deepEqual(other, []);
});

test("the rules catch what they should", () => {
  const ok = "create table if not exists public.a (id int);\n";
  const found = (files: { name: string; sql: string }[]) => problems(files).join("\n");
  assert.equal(found([{ name: "001_a.sql", sql: ok }, { name: "002_b.sql", sql: ok }]), "");
  assert.match(found([{ name: "001_a.sql", sql: ok }, { name: "003_c.sql", sql: ok }]), /002 is missing/);
  assert.match(found([{ name: "001_a.sql", sql: ok }, { name: "001_b.sql", sql: ok }]), /001 is used twice/);
  assert.match(found([{ name: "002_a.sql", sql: ok }]), /001 is missing/);
  assert.match(found([{ name: "1_a.sql", sql: ok }]), /name must look like/);
  assert.match(found([{ name: "001_a.sql", sql: "begin;\n" + ok + "commit;\n" }]), /starts its own transaction[\s\S]*ends a transaction/);
  assert.match(found([{ name: "001_a.sql", sql: "create index concurrently if not exists i on a (id);" }]), /CONCURRENTLY/);
  assert.match(found([{ name: "001_a.sql", sql: "vacuum analyze a;" }]), /VACUUM/);
  assert.match(found([{ name: "001_a.sql", sql: "create table public.a (id int);" }]), /create table public\.a needs "if not exists"/);
  assert.match(found([{ name: "001_a.sql", sql: "create unique index a_id on a (id);" }]), /create index a_id/);
  assert.match(found([{ name: "001_a.sql", sql: "create function f() returns int language sql as $$ select 1 $$;" }]), /or replace/);
  assert.match(found([{ name: "001_a.sql", sql: `create policy "read" on public.a for select using (true);` }]), /drop policy if exists/);
  assert.match(
    found([{ name: "001_a.sql", sql: `drop policy if exists "read" on public.b;\ncreate policy "read" on public.a for select using (true);` }]),
    /drop policy if exists/,
  );
  // Fine: a dropped-then-created policy, plpgsql begin/end blocks, and the words in comments or strings.
  const fine = [
    `drop policy if exists "read" on public.a;`,
    `create policy "read" on a for select using (true);`,
    "create or replace function f() returns void language plpgsql as $fn$ begin perform 1; end; $fn$;",
    "do $$ begin perform 1; end $$;",
    "-- never begin; or vacuum or create table x here",
    "select 'commit; concurrently';",
  ].join("\n");
  assert.equal(found([{ name: "001_a.sql", sql: fine }]), "");
});
