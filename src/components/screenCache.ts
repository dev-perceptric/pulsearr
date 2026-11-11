// Screens seen in this tab, by a key that's unique across the app (it carries the workspace and record ids), so going
// back to one (or opening one the pointer rested on) shows at once while a fresh copy loads behind it. Kept for the
// tab's life only; a reload, signing out or switching workspace starts empty. useLoad's `cacheAs` reads and writes it.

const seen = new Map<string, { at: number; data: unknown }>();
const asking = new Map<string, Promise<unknown>>();
const SEEN_MAX = 60;
// Goes up on each clear, so an answer that was on its way before it isn't kept.
let gen = 0;

export const screenGen = () => gen;

/** The last copy of a screen, or undefined. */
export function seenData<T>(key: string): T | undefined {
  return seen.get(key)?.data as T | undefined;
}

/** A prefetch on its way for this key, if any. */
export function asked(key: string): Promise<unknown> | undefined {
  return asking.get(key);
}

export function remember(key: string, data: unknown, from = gen) {
  if (from !== gen) return;
  seen.delete(key);
  seen.set(key, { at: Date.now(), data });
  if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value!);
}

/** Loads ahead of a click (on hover or focus), unless this screen was loaded in the last 15 seconds. */
export function prefetch(key: string, fn: () => Promise<unknown>) {
  const had = seen.get(key);
  if ((had && Date.now() - had.at < 15_000) || asking.has(key)) return;
  const from = gen;
  const p = fn()
    .then((d) => remember(key, d, from))
    .catch(() => {})
    .finally(() => asking.get(key) === p && asking.delete(key));
  asking.set(key, p);
}

/** Forgets every screen: on sign out and workspace switch. */
export function clearScreens() {
  gen++;
  seen.clear();
  asking.clear();
}
