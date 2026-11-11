"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useShell } from "@/components/AppShell";
import { askConfirm } from "@/components/Dialogs";
import { LogOut, Trash, X } from "@/components/Icons";
import { Loader } from "@/components/Loader";
import { rpcWrite } from "@/components/rpcWrite";
import { Select } from "@/components/Select";
import { SettingsSection } from "@/components/SettingsLayout";
import { canEditRole, canInvite, memberAction, parseTeam, type Member, type Role } from "@/components/shellState";
import { notify } from "@/components/Undo";
import { Badge, Button, clearScreens, ErrorNote, Field, IconButton, Input, Loading, Td, Th, useLoad } from "@/components/ui";
import { fmtDate, fmtNum } from "@/lib/format";
import { retryResult } from "@/lib/retry";

const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };
const ROLE_OPTIONS: { value: "admin" | "member"; label: string }[] = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
];

export function TeamSettings() {
  const { sb, user, workspace, refreshBoot } = useShell();
  const router = useRouter();
  const me = { id: user.id, role: workspace.role };
  const admin = canInvite(workspace.role);
  const { data, error, reload, set } = useLoad(
    async () => {
      const r = await retryResult(() => sb.rpc("team", { p_ws: workspace.id }));
      if (r.error) throw r.error;
      return parseTeam(r.data);
    },
    workspace.id,
    `team:${workspace.id}`,
  );

  async function changeRole(m: Member, role: "admin" | "member") {
    set((t) => (t ? { ...t, members: t.members.map((x) => (x.user_id === m.user_id ? { ...x, role } : x)) } : t));
    const r = await rpcWrite(sb, "set_member_role", { p_ws: workspace.id, p_user: m.user_id, p_role: role });
    if (!r.ok) {
      reload();
      notify(r.hiccup ? "Couldn't change the role." : r.message, r.hiccup ? { label: "Retry", run: () => void changeRole(m, role) } : undefined);
    }
  }

  async function removeMember(m: Member) {
    const r = await rpcWrite(sb, "remove_member", { p_ws: workspace.id, p_user: m.user_id });
    if (!r.ok) return notify(r.hiccup ? "Couldn't remove them." : r.message, r.hiccup ? { label: "Retry", run: () => void removeMember(m) } : undefined);
    reload();
    notify(`${m.email} removed`);
  }

  async function leave() {
    const r = await rpcWrite(sb, "remove_member", { p_ws: workspace.id, p_user: user.id });
    if (!r.ok) return notify(r.hiccup ? "Couldn't leave the workspace." : r.message, r.hiccup ? { label: "Retry", run: () => void leave() } : undefined);
    clearScreens();
    await refreshBoot().catch(() => {});
    router.push("/dashboard");
    notify(`You left ${workspace.name}`);
  }

  async function cancelInvite(id: string, email: string) {
    const r = await rpcWrite(sb, "cancel_invite", { p_invite: id });
    if (!r.ok) return notify(r.hiccup ? "Couldn't cancel the invite." : r.message, r.hiccup ? { label: "Retry", run: () => void cancelInvite(id, email) } : undefined);
    reload();
    notify(`Invite to ${email} canceled`);
  }

  if (!data) {
    return error ? (
      <div className="space-y-3">
        <ErrorNote message={error} />
        <Button variant="secondary" onClick={reload}>
          Retry
        </Button>
      </div>
    ) : (
      <Loading />
    );
  }

  return (
    <>
      <SettingsSection
        title={
          <>
            Members <span className="text-[13px] font-normal text-muted tabular-nums">{fmtNum(data.members.length)}</span>
          </>
        }
        sub="Who can open this workspace"
      >
        <div className="border border-line">
          <table className="w-full table-fixed border-collapse">
            <thead>
              <tr>
                <Th>Email</Th>
                <Th className="w-36">Role</Th>
                <Th className="w-14">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {data.members.map((m) => {
                const act = memberAction(me, m);
                return (
                  <tr key={m.user_id} className="row-hover">
                    <Td>
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="min-w-0 wrap-anywhere">{m.email}</span>
                        {m.user_id === user.id ? <Badge>You</Badge> : null}
                      </span>
                    </Td>
                    <Td>
                      {m.role === "owner" ? (
                        <Badge tone="brand">Owner</Badge>
                      ) : canEditRole(me, m) ? (
                        <Select ariaLabel={`Role for ${m.email}`} value={m.role as "admin" | "member"} options={ROLE_OPTIONS} onChange={(r) => void changeRole(m, r)} />
                      ) : (
                        ROLE_LABEL[m.role]
                      )}
                    </Td>
                    <Td className="text-right">
                      {act === "remove" ? (
                        <IconButton
                          label="Remove from team"
                          align="end"
                          onClick={async () => {
                            if (await askConfirm(`Remove ${m.email}?`, { body: `They lose access to ${workspace.name}.`, ok: "Remove", danger: true })) await removeMember(m);
                          }}
                        >
                          <Trash size={16} />
                        </IconButton>
                      ) : act === "leave" ? (
                        <IconButton
                          label="Leave workspace"
                          align="end"
                          onClick={async () => {
                            if (await askConfirm(`Leave ${workspace.name}?`, { body: "You'll need a new invite to come back.", ok: "Leave", danger: true })) await leave();
                          }}
                        >
                          <LogOut size={16} />
                        </IconButton>
                      ) : null}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SettingsSection>

      {admin ? (
        <SettingsSection title="Invite" sub="They join when they sign in with this email">
          <InviteForm
            onSent={() => reload()}
            invite={(email, role) => rpcWrite(sb, "invite_member", { p_ws: workspace.id, p_email: email, p_role: role })}
          />
          {data.invites.length ? (
            <ul className="mt-6 border border-line" aria-label="Invites">
              {data.invites.map((i) => (
                <li key={i.id} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-1.5 pr-1.5 pl-3 last:border-b-0">
                  <span className="min-w-0 flex-1 text-[13px] wrap-anywhere">{i.email}</span>
                  <Badge>{ROLE_LABEL[i.role]}</Badge>
                  <span className="text-[12px] text-muted tabular-nums">{fmtDate(i.created_at)}</span>
                  <IconButton
                    label="Cancel invite"
                    align="end"
                    onClick={async () => {
                      if (await askConfirm(`Remove the invite to ${i.email}?`, { body: "They won't join when they sign in.", ok: "Remove invite", danger: true })) await cancelInvite(i.id, i.email);
                    }}
                  >
                    <X size={16} />
                  </IconButton>
                </li>
              ))}
            </ul>
          ) : null}
        </SettingsSection>
      ) : null}
    </>
  );
}

function InviteForm({ invite, onSent }: { invite: (email: string, role: "admin" | "member") => ReturnType<typeof rpcWrite>; onSent: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(to: string, as: "admin" | "member") {
    setBusy(true);
    setError("");
    const r = await invite(to, as);
    setBusy(false);
    if (!r.ok) {
      if (r.hiccup) notify("Couldn't send the invite.", { label: "Retry", run: () => void send(to, as) });
      else setError(r.message);
      return;
    }
    setEmail("");
    onSent();
    notify(`Invite sent to ${to.toLowerCase()}`);
  }

  return (
    <form
      className="flex flex-wrap items-start gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const to = email.trim();
        if (to) void send(to, role);
      }}
    >
      <div className="min-w-0 flex-1 basis-56">
        <Field label="Email" error={error}>
          <Input
            type="email"
            required
            maxLength={254}
            autoComplete="off"
            value={email}
            aria-invalid={error ? true : undefined}
            onChange={(e) => {
              setEmail(e.target.value);
              setError("");
            }}
          />
        </Field>
      </div>
      <div className="w-36">
        <Field label="Role">
          <Select ariaLabel="Role" value={role} options={ROLE_OPTIONS} onChange={setRole} />
        </Field>
      </div>
      <div>
              {/* Lines the button up with the box under its label. */}
              <span aria-hidden="true" className="mb-1.5 block h-[18px]" />
        <Button type="submit" disabled={busy || !email.trim()}>
          {busy ? <Loader size={4} className="text-white" /> : null}
          Invite
        </Button>
      </div>
    </form>
  );
}
