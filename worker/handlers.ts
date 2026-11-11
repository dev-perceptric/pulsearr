// What the worker does for each kind of job: email.invite (M0); mrr.rebuild_customer (M1, worker/mrr.ts); the
// Stripe jobs stripe.backfill, stripe.backfill_finish, stripe.sync_object, stripe.poll_events and stripe.check
// (worker/stripe/); and fx.load (worker/fx.ts).

import { EmailError, inviteEmail, sendEmail, type Email, type SendResult } from "../src/lib/email.ts";
import { appUrl } from "../src/lib/env.ts";
import { JobError, type Handler } from "../src/lib/jobs.ts";
import type { RetryOptions } from "../src/lib/retry.ts";
import { loadRates } from "./fx.ts";
import { rebuildCustomer } from "./mrr.ts";
import type { Db } from "./pg.ts";
import { runBackfill, runBackfillFinish } from "./stripe/backfill.ts";
import { runCheck, runPollEvents, runSyncObject } from "./stripe/sync.ts";

export type HandlerDeps = {
  db: Db;
  send?: (email: Email) => Promise<SendResult>;
  appUrl?: string;
  log?: (msg: string) => void;
  /** Today's UTC day (YYYY-MM-DD); tests pin it. */
  today?: () => string;
  /** fetch for Stripe and the ECB; tests pass a fake. */
  fetch?: typeof fetch;
  /** The platform's Stripe secret key (STRIPE_SECRET_KEY), for refreshing Stripe App tokens. */
  stripeSecretKey?: () => string;
  /** Retry waits for Stripe and the ECB; tests shrink them. */
  retry?: RetryOptions;
  now?: () => number;
};

type InviteRow = { id: string; email: string; workspace_name: string; inviter_email: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function makeHandlers(deps: HandlerDeps): Record<string, Handler> {
  const send = deps.send ?? ((e: Email) => sendEmail(e));
  const log = deps.log ?? ((m: string) => console.log(m));
  const today = deps.today ?? (() => new Date().toISOString().slice(0, 10));
  const stripe = { db: deps.db, fetch: deps.fetch, secretKey: deps.stripeSecretKey, retry: deps.retry, now: deps.now, log, today };

  return {
    /** Send one invite. invite_member enqueues it with key = invite id and payload { invite_id }. */
    "email.invite": async (job) => {
      const inviteId = String(job.payload.invite_id ?? job.key ?? "");
      if (!UUID.test(inviteId)) throw new JobError(`email.invite: bad invite_id ${JSON.stringify(inviteId)}`, { retry: false });
      const { rows } = await deps.db.query<InviteRow>(
        `select i.id, i.email, w.name as workspace_name, u.email as inviter_email
           from public.invites i
           join public.workspaces w on w.id = i.workspace_id
           left join auth.users u on u.id = i.invited_by
          where i.id = $1`,
        [inviteId],
      );
      const invite = rows[0];
      // Cancelled or already used: nothing to send.
      if (!invite) return;
      const mail = inviteEmail({ workspaceName: invite.workspace_name, inviterEmail: invite.inviter_email, appUrl: deps.appUrl ?? appUrl() });
      try {
        const sent = await send({ to: invite.email, ...mail, idempotencyKey: invite.id });
        if (sent.skipped) log(`email.invite ${invite.id}: skipped, no RESEND_API_KEY`);
      } catch (e) {
        // A refused address or key won't change by trying again; anything else goes back to the queue's schedule.
        if (e instanceof EmailError && !e.retry) throw new JobError(e.message, { retry: false });
        throw e;
      }
    },

    /** Rebuild one Stripe customer's MRR from scratch. Payload { workspace_id, source_id, customer_id }; key `${source_id}:${customer_id}`. */
    "mrr.rebuild_customer": async (job) => {
      const out = await rebuildCustomer(deps.db, job.payload, today());
      if (out.skipped) log(`mrr.rebuild_customer ${String(job.payload.customer_id)}: source gone, nothing to do`);
    },

    /** Load one object type of a source's history, a page at a time. Payload { source_id, object }; key `${source_id}:${object}`. */
    "stripe.backfill": async (job, signal) => {
      const out = await runBackfill(stripe, job, signal);
      if (out) log(`stripe.backfill ${String(job.payload.object)} ${String(job.payload.source_id)}: ${out.rows} rows in ${out.pages} pages`);
    },

    /** Rebuild every customer of a source after its backfill. Payload { source_id, final }; key `${source_id}`. */
    "stripe.backfill_finish": async (job, signal) => {
      const out = await runBackfillFinish(stripe, job, signal);
      if (out) log(`stripe.backfill_finish ${String(job.payload.source_id)}: ${out.customers} customers, ${out.deferred} queued on their own`);
    },

    /** Fetch one object fresh and rebuild its customer. Payload { source_id, object_type, object_id }; key `${source_id}:${object_id}`. */
    "stripe.sync_object": async (job, signal) => {
      await runSyncObject(stripe, job, signal);
    },

    /** Read new events from Stripe. Payload { source_id }; key `${source_id}`. */
    "stripe.poll_events": async (job, signal) => {
      const out = await runPollEvents(stripe, job, signal);
      if (out?.stored) log(`stripe.poll_events ${String(job.payload.source_id)}: ${out.stored} new of ${out.seen}`);
    },

    /** Nightly: our MRR per customer against Stripe's open subscriptions. Payload { source_id }; key `${source_id}:${day}`. */
    "stripe.check": async (job, signal) => {
      const out = await runCheck(stripe, job, signal);
      if (out) log(`stripe.check ${String(job.payload.source_id)}: ${out.checked} customers, ${out.off.length} rebuilt`);
    },

    /** The ECB's reference rates. No payload; key the day. */
    "fx.load": async (_job, signal) => {
      await loadRates({ db: deps.db, fetch: deps.fetch, retry: deps.retry, log }, signal);
    },
  };
}
