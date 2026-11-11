// What the worker does for each kind of job: email.invite (M0) and mrr.rebuild_customer (M1, worker/mrr.ts).

import { EmailError, inviteEmail, sendEmail, type Email, type SendResult } from "../src/lib/email.ts";
import { appUrl } from "../src/lib/env.ts";
import { JobError, type Handler } from "../src/lib/jobs.ts";
import { rebuildCustomer } from "./mrr.ts";
import type { Db } from "./pg.ts";

export type HandlerDeps = {
  db: Db;
  send?: (email: Email) => Promise<SendResult>;
  appUrl?: string;
  log?: (msg: string) => void;
  /** Today's UTC day (YYYY-MM-DD); tests pin it. */
  today?: () => string;
};

type InviteRow = { id: string; email: string; workspace_name: string; inviter_email: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function makeHandlers(deps: HandlerDeps): Record<string, Handler> {
  const send = deps.send ?? ((e: Email) => sendEmail(e));
  const log = deps.log ?? ((m: string) => console.log(m));
  const today = deps.today ?? (() => new Date().toISOString().slice(0, 10));

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
  };
}
