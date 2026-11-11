"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useShell } from "@/components/AppShell";
import { askConfirm } from "@/components/Dialogs";
import { Loader } from "@/components/Loader";
import { rpcWrite } from "@/components/rpcWrite";
import { SettingsSection } from "@/components/SettingsLayout";
import { canDeleteWorkspace, canRename } from "@/components/shellState";
import { notify } from "@/components/Undo";
import { Button, clearScreens, Field, Input } from "@/components/ui";

export function WorkspaceSettings() {
  const { sb, workspace, refreshBoot } = useShell();
  const router = useRouter();
  const [name, setName] = useState(workspace.name);
  const [shown, setShown] = useState(workspace.name);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // A new name from boot (another tab, another workspace) replaces the box's text.
  if (shown !== workspace.name) {
    setShown(workspace.name);
    setName(workspace.name);
  }
  const trimmed = name.trim();

  async function save() {
    if (!trimmed || trimmed === workspace.name) return;
    setBusy(true);
    setError("");
    const r = await rpcWrite(sb, "rename_workspace", { p_ws: workspace.id, p_name: trimmed });
    setBusy(false);
    if (!r.ok) {
      if (r.hiccup) notify("Couldn't save the name.", { label: "Retry", run: () => void save() });
      else setError(r.message);
      return;
    }
    await refreshBoot().catch(() => {});
    notify("Workspace renamed");
  }

  async function remove() {
    const r = await rpcWrite(sb, "delete_workspace", { p_ws: workspace.id });
    if (!r.ok) {
      notify(r.hiccup ? "Couldn't delete the workspace." : r.message, r.hiccup ? { label: "Retry", run: () => void remove() } : undefined);
      return;
    }
    clearScreens();
    await refreshBoot().catch(() => {});
    router.push("/dashboard");
    notify("Workspace deleted");
  }

  return (
    <>
      <SettingsSection title="Name" sub="The name your team sees">
        {canRename(workspace.role) ? (
          <form
            className="flex flex-wrap items-start gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="min-w-0 flex-1 basis-64">
              <Field label="Workspace name" error={error}>
                <Input
                  value={name}
                  maxLength={80}
                  aria-invalid={error ? true : undefined}
                  onChange={(e) => {
                    setName(e.target.value);
                    setError("");
                  }}
                />
              </Field>
            </div>
            <div>
              {/* Lines the button up with the box under its label. */}
              <span aria-hidden="true" className="mb-1.5 block h-[18px]" />
              <Button type="submit" disabled={busy || !trimmed || trimmed === workspace.name}>
                {busy ? <Loader size={4} className="text-white" /> : null}
                Save
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-[14px] wrap-anywhere text-ink">{workspace.name}</p>
        )}
      </SettingsSection>
      {canDeleteWorkspace(workspace.role) ? (
        <SettingsSection
          title="Delete workspace"
          sub="Removes the workspace, its team and its invites"
          danger
          action={
            <Button
              variant="danger"
              onClick={async () => {
                const ok = await askConfirm(`Delete ${workspace.name}?`, {
                  body: `${workspace.name}, its team and its invites are removed for everyone. This can't be undone.`,
                  ok: "Delete workspace",
                  danger: true,
                });
                if (ok) await remove();
              }}
            >
              Delete workspace
            </Button>
          }
        />
      ) : null}
    </>
  );
}
