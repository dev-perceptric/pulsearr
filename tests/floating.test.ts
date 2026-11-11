// Menus, pickers and tooltips open on one floating layer (src/components/Floating.tsx), so no table, card or panel
// can cut them off. These tests check where they land, and fail if a popup is ever drawn inside its box.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { place } from "../src/lib/place.ts";

const screen = { width: 1200, height: 800 };
const at = (left: number, top: number, width = 32, height = 32) => ({ left, top, right: left + width, bottom: top + height, width, height });

test("a menu opens under its button, lined up with the chosen edge", () => {
  const s = place(at(1000, 100), { width: 200, height: 120 }, "bottom-end", 4, screen);
  assert.deepEqual([s.left, s.top], [832, 136]);
  const start = place(at(100, 100), { width: 200, height: 120 }, "bottom-start", 4, screen);
  assert.deepEqual([start.left, start.top], [100, 136]);
});

test("near the bottom of the screen it flips above; with room on neither side it scrolls inside", () => {
  const up = place(at(100, 740), { width: 200, height: 160 }, "bottom-start", 4, screen);
  assert.equal(up.top, 740 - 4 - 160);
  const tall = place(at(100, 380), { width: 200, height: 2000 }, "bottom-start", 4, screen);
  assert.ok(tall.maxHeight! < 800 && tall.top >= 8, "it keeps to the screen and scrolls");
});

test("it never goes off either side of the screen", () => {
  assert.equal(place(at(4, 100), { width: 200, height: 50 }, "bottom-end", 4, screen).left, 8);
  assert.equal(place(at(1190, 100, 8), { width: 300, height: 50 }, "bottom-start", 4, screen).left, 1200 - 300 - 8);
  assert.equal(place(at(600, 100), { width: 100, height: 20 }, "top", 6, screen).left, 616 - 50);
});

test("a side panel opens to the other side when there's no room", () => {
  const s = place(at(1100, 100, 60, 32), { width: 240, height: 100 }, "right-start", 4, screen);
  assert.equal(s.left, 1100 - 4 - 240);
});

// Every popup goes through Floating, FloatingHere, HoverTip, Tip or OnTop. A menu, list, dialog or tooltip placed
// with `absolute` inside its parent gets hidden under a table or card edge, so it fails here.
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

test("no popup is drawn inside its box", () => {
  const app = [...files("src/components"), ...files("src/app")];
  const bad: string[] = [];
  for (const f of app) {
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((line, i) => {
        const cls = line.match(/className=\{?["`]([^"`]*)["`]/)?.[1] ?? "";
        const absolute = /(^|\s)absolute(\s|$)/.test(cls);
        const popup = /(^|\s)(top-full|bottom-full)(\s|$)/.test(cls) || /role="(menu|listbox|tooltip)"/.test(line) || (/(^|\s)bg-scrim(\s|$)/.test(cls) && /invisible|opacity-0/.test(cls));
        if (absolute && popup) bad.push(`${f}:${i + 1}`);
      });
  }
  assert.deepEqual(bad, [], `Use Floating (src/components/Floating.tsx) for these popups:\n${bad.join("\n")}`);
});
