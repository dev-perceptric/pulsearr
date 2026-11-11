// What the app shell keeps between loads, and who may do what on the team. Pure, with the browser's storage passed
// in, so it's tested without a browser (tests/appShell.test.ts). The shell draws from the last boot right away and
// swaps in the fresh one when `boot()` answers (docs/m0-plan.md section 3.2).

export type Role = "owner" | "admin" | "member";
export type WorkspaceRef = { id: string; name: string; role: Role };
export type Boot = { user: { id: string; email: string | null }; workspace: WorkspaceRef | null; workspaces: WorkspaceRef[] };

/** The bits of Storage the shell uses; null when the browser blocks storage. */
export type Store = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;

export const BOOT_KEY = "pulsearr:boot";
export const PREF_KEY = "pulsearr:workspace";

const ROLES = new Set<string>(["owner", "admin", "member"]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function workspaceOf(v: unknown): WorkspaceRef | null {
  if (!isObj(v) || typeof v.id !== "string" || !v.id || typeof v.name !== "string" || typeof v.role !== "string" || !ROLES.has(v.role)) return null;
  return { id: v.id, name: v.name, role: v.role as Role };
}

/** A boot answer (from the server or from storage) checked field by field, or null when it isn't one. */
export function parseBoot(v: unknown): Boot | null {
  if (!isObj(v) || !isObj(v.user) || typeof v.user.id !== "string" || !v.user.id) return null;
  if (!Array.isArray(v.workspaces)) return null;
  const workspaces = v.workspaces.map(workspaceOf).filter((w): w is WorkspaceRef => w !== null);
  const email = typeof v.user.email === "string" ? v.user.email : null;
  return { user: { id: v.user.id, email }, workspace: pickWorkspace(workspaceOf(v.workspace), workspaces), workspaces };
}

/** The workspace to open: the one boot named when it's in the list, else the first one, else none. */
export function pickWorkspace(named: WorkspaceRef | null, list: WorkspaceRef[]): WorkspaceRef | null {
  if (named) return list.find((w) => w.id === named.id) ?? (list.length ? list[0]! : named);
  return list[0] ?? null;
}

const safe = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

/** The last boot saved for this person, or null (none, someone else's, or not readable). */
export function readBoot(store: Store, userId: string): Boot | null {
  if (!store || !userId) return null;
  const raw = safe(() => store.getItem(BOOT_KEY), null);
  if (!raw) return null;
  const v = safe<unknown>(() => JSON.parse(raw), null);
  const b = parseBoot(v);
  return b && b.user.id === userId ? b : null;
}

export function saveBoot(store: Store, boot: Boot) {
  if (!store) return;
  safe(() => store.setItem(BOOT_KEY, JSON.stringify(boot)), undefined);
}

export function forgetBoot(store: Store) {
  if (!store) return;
  safe(() => store.removeItem(BOOT_KEY), undefined);
  safe(() => store.removeItem(PREF_KEY), undefined);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The workspace picked last on this browser, when it's a real id (boot takes a uuid). */
export function readPref(store: Store): string | null {
  if (!store) return null;
  const v = safe(() => store.getItem(PREF_KEY), null)?.trim() ?? "";
  return UUID.test(v) ? v : null;
}

export function savePref(store: Store, id: string | null) {
  if (!store) return;
  safe(() => (id ? store.setItem(PREF_KEY, id) : store.removeItem(PREF_KEY)), undefined);
}

/** Whether two boots would draw the same shell, so a refresh that changed nothing doesn't redraw. */
export const sameBoot = (a: Boot | null, b: Boot | null) => JSON.stringify(a) === JSON.stringify(b);

// Who may do what. The database checks every one of these again (004_team.sql); these only decide what to show.

export const isAdmin = (role: Role | null | undefined) => role === "owner" || role === "admin";
export const canRename = isAdmin;
export const canInvite = isAdmin;
export const canDeleteWorkspace = (role: Role | null | undefined) => role === "owner";

/** Whether `me` may change `target`'s role: admins and the owner, never the owner's role, never their own. */
export function canEditRole(me: { id: string; role: Role | null | undefined }, target: { user_id: string; role: Role }) {
  return isAdmin(me.role) && target.role !== "owner" && target.user_id !== me.id;
}

/** What `me` can do to `target` in the members list: remove them, leave (it's me), or nothing. */
export function memberAction(me: { id: string; role: Role | null | undefined }, target: { user_id: string; role: Role }): "remove" | "leave" | null {
  if (target.role === "owner") return null;
  if (target.user_id === me.id) return "leave";
  return isAdmin(me.role) ? "remove" : null;
}

export type Member = { user_id: string; email: string; role: Role; created_at: string };
export type Invite = { id: string; email: string; role: "admin" | "member"; created_at: string };
export type Team = { members: Member[]; invites: Invite[] };

/** The team() answer, checked; anything malformed drops out rather than drawing a broken row. */
export function parseTeam(v: unknown): Team {
  const o = isObj(v) ? v : {};
  const members = (Array.isArray(o.members) ? o.members : []).filter(
    (m): m is Member => isObj(m) && typeof m.user_id === "string" && typeof m.email === "string" && typeof m.role === "string" && ROLES.has(m.role),
  );
  const invites = (Array.isArray(o.invites) ? o.invites : []).filter(
    (i): i is Invite => isObj(i) && typeof i.id === "string" && typeof i.email === "string" && (i.role === "admin" || i.role === "member"),
  );
  return { members, invites };
}

/** Which settings section an address opens. */
export const SETTINGS_SECTIONS = ["workspace", "team", "account"] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];
export function sectionOf(path: string): SettingsSectionId {
  const seg = path.replace(/^\/settings\/?/, "").split(/[/?#]/)[0] ?? "";
  return (SETTINGS_SECTIONS as readonly string[]).includes(seg) ? (seg as SettingsSectionId) : "workspace";
}

/** Which sidebar item is picked for an address. */
export function navOf(path: string): "dashboard" | "settings" | null {
  if (path === "/dashboard" || path.startsWith("/dashboard/")) return "dashboard";
  if (path === "/settings" || path.startsWith("/settings/")) return "settings";
  return null;
}
