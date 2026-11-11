// What the worker does for each kind of job. M0 has one: email.invite.

import { EmailError, inviteEmail, sendEmail, type Email, type SendResult } from "../src/lib/email.ts";
import { appUrl } from "../src/lib/env.ts";
import { JobError, type Handler } from "../src/lib/jobs.ts";
import type { Db } from "./pg.ts";

export type HandlerDeps = {
  db: Db;
  send?: (email: Email) => Promise<SendResult>;
  appUrl?: string;
  log?: (msg: string) => void;
};

type InviteRow = { id: string; email: string; workspace_name: string; inviter_email: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function makeHandlers(deps: HandlerDeps): Record<string, Handler> {
  const send = deps.send ?? ((e: Email) => sendEmail(e));
  const log = deps.log ?? ((m: string) => console.log(m));

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
  };
}
