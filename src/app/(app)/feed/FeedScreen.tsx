"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useShell } from "@/components/AppShell";
import { ConnectStripe } from "@/components/ConnectStripe";
import { HoverTip } from "@/components/Floating";
import { Loader } from "@/components/Loader";
import { useSources } from "@/components/revenue";
import { isAdmin } from "@/components/shellState";
import { dashboardState, FEED_LABEL, feedTone, mergeFeed, olderCursor, parseFeed, type FeedItem } from "@/components/sourceState";
import { ToolIntro } from "@/components/ToolIntro";
import { notify } from "@/components/Undo";
import { Badge, Button, Dot, ErrorNote, Loading, Page, WIDE } from "@/components/ui";
import { fmtAgo, fmtDateTime, fmtMoneyExact, fromMinor } from "@/lib/format";
import { retryResult } from "@/lib/retry";

// The live feed (docs/m1-plan.md section 5): every signup, upgrade, downgrade, cancel, reactivation, failed payment
// and refund, newest first. The newest page is read again every 15 seconds and new rows flash ice once; older pages
// load on "Load older".

const LIMIT = 50;
const EVERY = 15_000;

export function FeedScreen() {
  const { sb, workspace } = useShell();
  const src = useSources(sb, workspace.id);
  const state = src.data ? dashboardState(src.data.sources) : null;
  return (
    <Page
      title="Feed"
      badge={
        state && state !== "none" ? (
          <span className="flex items-center gap-1.5 text-[12px] leading-4 text-muted">
            <Dot tone="green" />
            Live
          </span>
        ) : undefined
      }
    >
      {!src.data ? (
        src.error ? (
          <div className={`${WIDE} space-y-3`}>
            <ErrorNote message={src.error} />
            <Button variant="secondary" onClick={src.reload}>
              Retry
            </Button>
          </div>
        ) : (
          <Loading />
        )
      ) : state === "none" ? (
        <ToolIntro
          drawing="activity"
          title="Every signup and cancel, as it happens"
          lead={isAdmin(workspace.role) ? "Connect Stripe to fill the feed." : "Ask an owner or admin to connect Stripe."}
          action={isAdmin(workspace.role) ? <ConnectStripe /> : undefined}
        />
      ) : (
        <Feed key={workspace.id} />
      )}
    </Page>
  );
}

function Feed() {
  const { sb, workspace } = useShell();
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [error, setError] = useState("");
  const [older, setOlder] = useState(true);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const have = useRef<FeedItem[] | null>(null);
  const stuck = useRef(false);

  const ask = useCallback(
    async (before: string | null) => {
      const r = await retryResult(() => sb.rpc("feed", { p_ws: workspace.id, p_before: before, p_limit: LIMIT }));
      if (r.error) throw new Error(r.error.message);
      return parseFeed(r.data);
    },
    [sb, workspace.id],
  );

  const keep = (next: FeedItem[]) => {
    have.current = next;
    setItems(next);
  };

  // The newest page, now and every 15 seconds while the tab is showing.
  useEffect(() => {
    let live = true;
    const refresh = async () => {
      if (document.hidden && have.current) return;
      try {
        const page = await ask(null);
        if (!live) return;
        const before = have.current;
        if (!before) {
          keep(page);
          setOlder(page.length >= LIMIT);
        } else {
          const seen = new Set(before.map((f) => f.id));
          setFresh(new Set(page.filter((f) => !seen.has(f.id)).map((f) => f.id)));
          keep(mergeFeed(before, page));
        }
        setError("");
      } catch (e) {
        // With rows on screen, a missed refresh stays quiet; the next one tries again.
        if (live && !have.current) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void refresh();
    const t = setInterval(() => void refresh(), EVERY);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [ask]);

  async function loadOlder() {
    const list = have.current;
    if (!list || busy) return;
    setBusy(true);
    try {
      const page = await ask(olderCursor(list, stuck.current));
      const merged = mergeFeed(have.current ?? list, page);
      const added = merged.length - (have.current ?? list).length;
      // A full page with nothing new means many items share one moment: next time ask strictly before it.
      stuck.current = added === 0 && page.length >= LIMIT && !stuck.current;
      keep(merged);
      setOlder(page.length >= LIMIT && (added > 0 || stuck.current));
    } catch {
      notify("Couldn't load older events.", { label: "Retry", run: () => void loadOlder() });
    }
    setBusy(false);
  }

  if (!items)
    return error ? (
      <div className={`${WIDE} space-y-3`}>
        <ErrorNote message={error} />
        <Button variant="secondary" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </div>
    ) : (
      <Loading />
    );

  if (!items.length) return <p className={`${WIDE} py-12 text-center text-[14px] text-muted`}>No events yet</p>;

  return (
    <div className={WIDE}>
      <ul className="border border-line" aria-label="Events" aria-live="polite">
        {items.map((f) => (
          <FeedRow key={f.id} f={f} fresh={fresh.has(f.id)} />
        ))}
      </ul>
      {older ? (
        <div className="flex justify-center py-4">
          <Button variant="secondary" onClick={() => void loadOlder()} disabled={busy} aria-busy={busy}>
            {busy ? <Loader size={4} /> : null}
            Load older
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function FeedRow({ f, fresh }: { f: FeedItem; fresh: boolean }) {
  const code = f.currency.toUpperCase();
  const other = f.original_currency.toLowerCase() !== f.currency.toLowerCase();
  const who = f.customer_name ?? f.customer_email ?? f.customer_id;
  return (
    <li className={`grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 border-b border-line px-4 py-3 last:border-b-0 md:grid-cols-[8rem_minmax(0,1fr)_auto_7rem] md:px-6 ${fresh ? "flash" : ""}`}>
      <span className="pt-px max-md:col-start-1 max-md:row-start-1">
        <Badge tone={feedTone(f.kind)}>{FEED_LABEL[f.kind]}</Badge>
      </span>
      <span className="min-w-0 max-md:col-start-1 max-md:row-start-2">
        <span className="block text-[14px] leading-5 wrap-anywhere text-ink">{who}</span>
        {f.customer_name && f.customer_email ? <span className="block text-[12px] leading-4 wrap-anywhere text-muted">{f.customer_email}</span> : null}
      </span>
      <span className="num text-right text-[14px] leading-5 text-ink max-md:col-start-2 max-md:row-start-2">
        {fmtMoneyExact(fromMinor(f.amount, code), code, { code: other })}
        {other ? <span className="block text-[12px] leading-4 text-muted">{fmtMoneyExact(fromMinor(f.original_amount, f.original_currency), f.original_currency.toUpperCase(), { code: true })}</span> : null}
      </span>
      <span tabIndex={0} className="num rounded-xs text-right text-[13px] leading-5 text-muted max-md:col-start-2 max-md:row-start-1">
        {fmtAgo(f.at)}
        <HoverTip text={fmtDateTime(f.at, { year: true })} placement="top-end" />
      </span>
    </li>
  );
}
