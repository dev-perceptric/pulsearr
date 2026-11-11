"use client";

import { useEffect, useState } from "react";
import { useShell } from "@/components/AppShell";
import { ConnectStripe } from "@/components/ConnectStripe";
import { askConfirm } from "@/components/Dialogs";
import { KeyRound, Trash } from "@/components/Icons";
import { Loader } from "@/components/Loader";
import { Modal } from "@/components/Overlay";
import { postRetry, useSources } from "@/components/revenue";
import { SettingsSection } from "@/components/SettingsLayout";
import { isAdmin } from "@/components/shellState";
import { connectError, importProgress, looksLikeKey, STATUS_LABEL, statusTone, type Source } from "@/components/sourceState";
import { notify } from "@/components/Undo";
import { announceChange, Badge, Button, ErrorNote, Field, IconButton, Input, Loading, Td, Th } from "@/components/ui";
import { fmtAgo } from "@/lib/format";
import { isHiccup } from "@/lib/retry";
import { plainError } from "@/lib/plainError";

// Settings → Sources: the Stripe accounts this workspace reads, each with its status, import progress and last sync,
// Connect Stripe, the restricted-key fallback, and disconnect. Stripe's callback lands here, with ?error=<code> when
// connecting didn't work; that shows as one short line.

export function SourcesSettings() {
  const { sb, workspace } = useShell();
  const { data, error, reload } = useSources(sb, workspace.id);
  const admin = isAdmin(workspace.role);
  // Read ?error= once, then take it out of the address so a reload doesn't show it again.
  const [callbackError] = useState(() => (typeof window === "undefined" ? "" : connectError(new URLSearchParams(window.location.search).get("error"))));
  const [keyOpen, setKeyOpen] = useState(false);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("error")) return;
    url.searchParams.delete("error");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
  }, []);

  async function disconnect(s: Source) {
    const name = s.account_name ?? s.account_id;
    const ok = await askConfirm(`Disconnect ${name}?`, { body: "Every number imported from this account is deleted.", ok: "Disconnect", danger: true });
    if (!ok) return;
    try {
      await postRetry("/api/sources/delete", { source_id: s.id });
      reload();
      announceChange();
      notify(`${name} disconnected`);
    } catch (e) {
      notify(isHiccup(e) ? "Couldn't disconnect it." : plainError(e, "Couldn't disconnect it."), { label: "Retry", run: () => void disconnect(s) });
    }
  }

  const live = data?.sources.filter((s) => s.status !== "disconnected") ?? [];

  return (
    <>
      <SettingsSection
        title="Stripe"
        sub="The Stripe accounts PulseARR reads"
        action={
          admin ? (
            <>
              <Button variant="secondary" onClick={() => setKeyOpen(true)}>
                <KeyRound size={16} />
                Use a restricted key
              </Button>
              <ConnectStripe />
            </>
          ) : undefined
        }
      >
        <div className="space-y-4">
          {callbackError ? <ErrorNote message={callbackError} /> : null}
          {!data ? (
            error ? (
              <div className="space-y-3">
                <ErrorNote message={error} />
                <Button variant="secondary" onClick={reload}>
                  Retry
                </Button>
              </div>
            ) : (
              <Loading />
            )
          ) : !live.length ? (
            <p className="border border-line px-6 py-8 text-[14px] text-muted">{admin ? "No Stripe account connected" : "No Stripe account connected. Ask an owner or admin to connect one."}</p>
          ) : (
            <>
            <ul className="border border-line md:hidden" aria-label="Stripe accounts">
              {live.map((s) => (
                <SourceItem key={s.id} s={s} admin={admin} onDisconnect={() => void disconnect(s)} />
              ))}
            </ul>
            <div className="hidden overflow-x-auto border border-line md:block">
              <table className="w-full min-w-[560px] border-collapse">
                <thead>
                  <tr>
                    <Th>Account</Th>
                    <Th className="w-32">Status</Th>
                    <Th>Import</Th>
                    <Th className="w-32">Last sync</Th>
                    {admin ? (
                      <Th className="w-14">
                        <span className="sr-only">Actions</span>
                      </Th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {live.map((s) => (
                    <SourceRow key={s.id} s={s} admin={admin} onDisconnect={() => void disconnect(s)} />
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </div>
      </SettingsSection>
      {keyOpen ? (
        <KeyDialog
          onClose={() => setKeyOpen(false)}
          onDone={() => {
            setKeyOpen(false);
            reload();
            announceChange();
          }}
        />
      ) : null}
    </>
  );
}

function SourceRow({ s, admin, onDisconnect }: { s: Source; admin: boolean; onDisconnect: () => void }) {
  const p = importProgress(s.backfill);
  const importing = s.status === "importing" || s.status === "connecting";
  const name = s.account_name ?? s.account_id;
  return (
    <tr className="row-hover">
      <Td>
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 wrap-anywhere text-ink">{name}</span>
          {!s.livemode ? <Badge tone="amber">Test mode</Badge> : null}
          {s.kind === "stripe_key" ? <Badge>Key</Badge> : null}
        </span>
        {s.account_name ? <span className="block font-mono text-[12px] leading-4 wrap-anywhere text-muted">{s.account_id}</span> : null}
        {s.status === "error" && s.last_error ? <span className="mt-1 block text-[12px] leading-4 wrap-break-word text-danger">{plainError(s.last_error, "The sync stopped. Connect again.")}</span> : null}
      </Td>
      <Td>
        <Badge tone={statusTone(s.status)}>{STATUS_LABEL[s.status]}</Badge>
      </Td>
      <Td className="num text-muted">
        <span className="flex items-start gap-2">
          {importing ? <Loader size={4} className="mt-1.5 text-brand" /> : null}
          <span className="min-w-0 wrap-break-word">{p.text || (importing ? "Starting" : "—")}</span>
        </span>
      </Td>
      <Td className="num text-muted">{s.last_synced_at ? fmtAgo(s.last_synced_at) : "—"}</Td>
      {admin ? (
        <Td className="text-right">
          <IconButton label={`Disconnect ${name}`} align="end" onClick={onDisconnect}>
            <Trash size={16} />
          </IconButton>
        </Td>
      ) : null}
    </tr>
  );
}

/** One account on a phone: the same facts as a table row, stacked. */
function SourceItem({ s, admin, onDisconnect }: { s: Source; admin: boolean; onDisconnect: () => void }) {
  const p = importProgress(s.backfill);
  const importing = s.status === "importing" || s.status === "connecting";
  const name = s.account_name ?? s.account_id;
  return (
    <li className="flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-[14px] leading-5 wrap-anywhere text-ink">{name}</p>
        {s.account_name ? <p className="font-mono text-[12px] leading-4 wrap-anywhere text-muted">{s.account_id}</p> : null}
        <p className="flex flex-wrap items-center gap-1.5">
          <Badge tone={statusTone(s.status)}>{STATUS_LABEL[s.status]}</Badge>
          {!s.livemode ? <Badge tone="amber">Test mode</Badge> : null}
          {s.kind === "stripe_key" ? <Badge>Key</Badge> : null}
        </p>
        {s.status === "error" && s.last_error ? <p className="text-[12px] leading-4 wrap-break-word text-danger">{plainError(s.last_error, "The sync stopped. Connect again.")}</p> : null}
        <p className="num flex items-start gap-2 text-[13px] leading-[18px] text-muted">
          {importing ? <Loader size={4} className="mt-1.5 text-brand" /> : null}
          <span className="min-w-0 wrap-break-word">{p.text || (importing ? "Starting" : "—")}</span>
        </p>
        <p className="num text-[12px] leading-4 text-muted">{s.last_synced_at ? `Synced ${fmtAgo(s.last_synced_at)}` : "Not synced yet"}</p>
      </div>
      {admin ? (
        <IconButton label={`Disconnect ${name}`} align="end" onClick={onDisconnect}>
          <Trash size={16} />
        </IconButton>
      ) : null}
    </li>
  );
}

/** The fallback when the Stripe App can't be used: one box for a restricted key. */
function KeyDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { workspace } = useShell();
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const value = key.trim();

  async function save() {
    if (!value || busy) return;
    if (!looksLikeKey(value)) return setError("That doesn't look like a Stripe key. It starts with rk_live_ or rk_test_.");
    setBusy(true);
    setError("");
    try {
      const r = await postRetry<{ ok?: boolean; error?: string }>("/api/sources/key", { workspace_id: workspace.id, key: value });
      if (r.error || r.ok === false) throw new Error(r.error ?? "Stripe didn't accept that key.");
      notify("Stripe connected");
      onDone();
    } catch (e) {
      setBusy(false);
      if (isHiccup(e)) notify("Couldn't reach PulseARR.", { label: "Retry", run: () => void save() });
      else setError(plainError(e, "Stripe didn't accept that key."));
    }
  }

  return (
    <Modal
      title="Use a restricted key"
      onClose={onClose}
      submit
      locked={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!value || busy} aria-busy={busy}>
            {busy ? <Loader size={4} className="text-white" /> : null}
            Connect
          </Button>
        </>
      }
    >
      <Field label="Restricted key" error={error}>
        <Input
          autoFocus
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setError("");
          }}
          placeholder="rk_live_…"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          className="font-mono"
        />
      </Field>
    </Modal>
  );
}
