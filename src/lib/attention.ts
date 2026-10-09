import 'server-only';

import { sql } from 'drizzle-orm';
import { withUser } from '@/db/session';

/**
 * VIXART OS — what needs attention right now.
 *
 * Derived from current state on every read, not stored. A notifications table
 * would need delivery, read/unread and cleanup, and would drift: a row saying
 * "task overdue" outlives the task being finished. Computing it means it is
 * always true, and dismissing something means doing it.
 *
 * The trade-off is that it cannot say "you have not seen this yet". For a team
 * of five sharing one active client, that is not the problem worth solving.
 *
 * Everything is role-scoped, and every query still runs through RLS — a member
 * asking for invoice items gets nothing back regardless of what this file asks.
 */

export type Severity = 'now' | 'soon' | 'setup';

export interface AttentionItem {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  href: string;
}

interface Row {
  [k: string]: unknown;
  kind: string;
  n: string;
  detail: string | null;
  ref: string | null;
}

export async function getAttention(): Promise<AttentionItem[]> {
  return withUser(async (tx, user) => {
    const isAdmin = user.role === 'admin';
    // Retainers are revenue contracts: the same reach as deals, which is
    // moderator and above, not the narrower money-only reach of an invoice.
    const isModerator = user.role === 'admin' || user.role === 'moderator';
    const canSignOff = user.role === 'admin' || user.role === 'moderator';

    const result = await tx.execute<Row>(sql`
      -- Tasks assigned to me, past their due date.
      SELECT 'my_overdue' AS kind, count(*)::text AS n,
             min(t.due_date)::text AS detail, NULL AS ref
        FROM task t
       WHERE t.assignee_id = ${user.id} AND t.status <> 'completed'
         AND t.due_date IS NOT NULL AND t.due_date < current_date
      HAVING count(*) > 0

      UNION ALL
      -- Assigned to me and due today.
      SELECT 'my_today', count(*)::text, NULL, NULL
        FROM task t
       WHERE t.assignee_id = ${user.id} AND t.status <> 'completed'
         AND t.due_date = current_date
      HAVING count(*) > 0

      UNION ALL
      -- I said I was done; nobody has signed it off yet.
      SELECT 'my_submitted', count(*)::text, NULL, NULL
        FROM task t
       WHERE t.assignee_id = ${user.id} AND t.status = 'submitted'
      HAVING count(*) > 0

      UNION ALL
      -- Waiting on me to sign off.
      SELECT 'to_sign_off', count(*)::text, NULL, NULL
        FROM task t
       WHERE ${canSignOff} AND t.status = 'submitted'
      HAVING count(*) > 0

      /*
       * ---- THE DELIVERY QUEUE ---------------------------------------------
       *
       * This page knew about invoices, retainers, quiet clients, unpriced
       * services and the reader's own tasks — and nothing whatsoever about the
       * work itself. So the dashboard would say one task was overdue, /tasks
       * would show an urgent one past its date and /projects an active project
       * a fortnight late, and "Needs attention" listed aged drafts and account
       * setup. Management could sit on this page, trusting it, while delivery
       * slipped.
       *
       * Everything below is management's: a member already sees their own work
       * in the four arms above, and the whole point of these is the view ACROSS
       * people that nobody else has.
       */
      UNION ALL
      -- Somebody else's work, past its date. Named by WHO, because that is the
      -- next action: a count of overdue tasks is a worry, a person is a
      -- conversation.
      SELECT 'team_overdue', count(*)::text,
             min(t.due_date)::text, min(u.full_name)
        FROM task t
        JOIN app_user u ON u.id = t.assignee_id
       WHERE ${isModerator}
         AND t.status <> 'completed'
         AND t.due_date IS NOT NULL AND t.due_date < current_date
         -- Theirs, not mine: my_overdue has already said so, and saying it
         -- twice in different words on one page is how a page stops being read.
         AND t.assignee_id <> ${user.id}
      HAVING count(*) > 0

      UNION ALL
      /*
       * Work that belongs to nobody.
       *
       * Aged deliberately — min(created_at) rather than a count alone. A task
       * raised this morning with no assignee is a normal five minutes of life;
       * one raised three weeks ago is a decision nobody has made, and the two
       * must not read the same.
       */
      SELECT 'unassigned_tasks', count(*)::text,
             min(t.created_at)::date::text, min(t.title)
        FROM task t
       WHERE ${isModerator}
         AND t.status <> 'completed'
         AND t.assignee_id IS NULL
      HAVING count(*) > 0

      UNION ALL
      -- Somebody has stopped and said why. Until a moderator reads it, the
      -- person who raised the flag is the only one who knows.
      SELECT 'blocked_tasks', count(*)::text, NULL, min(t.title)
        FROM task t
       WHERE ${isModerator} AND t.status = 'blocked'
      HAVING count(*) > 0

      UNION ALL
      -- A project past its date. Not archived and not delivered, so this is work
      -- that is genuinely still owed to a client.
      SELECT 'overdue_projects', count(*)::text,
             min(p.due_date)::text, min(p.name)
        FROM project p
       WHERE ${isModerator}
         AND p.archived_at IS NULL
         AND p.status NOT IN ('delivered')
         AND p.due_date IS NOT NULL AND p.due_date < current_date
      HAVING count(*) > 0

      UNION ALL
      -- Live work nobody is accountable for.
      SELECT 'projects_no_lead', count(*)::text, NULL, min(p.name)
        FROM project p
       WHERE ${isModerator}
         AND p.archived_at IS NULL
         AND p.lead_id IS NULL
         AND p.status IN ('active', 'planned')
      HAVING count(*) > 0

      UNION ALL
      -- Issued, past due, unpaid.
      SELECT 'overdue_invoices', count(*)::text,
             sum(d.net_to_collect)::text, NULL
        FROM document d
       WHERE ${isAdmin} AND d.doc_type = 'facture' AND d.status = 'emis'
         AND d.due_date IS NOT NULL AND d.due_date < current_date
      HAVING count(*) > 0

      UNION ALL
      -- Drafts sitting unissued for over a week.
      SELECT 'stale_drafts', count(*)::text, NULL, NULL
        FROM document d
       WHERE ${isAdmin} AND d.status = 'brouillon'
         AND d.created_at < now() - interval '7 days'
      HAVING count(*) > 0

      UNION ALL
      -- Active services still priced at zero: a quote built from these is wrong.
      SELECT 'unpriced_services', count(*)::text, NULL, NULL
        FROM service s
       WHERE ${isAdmin} AND s.is_active
         AND coalesce((SELECT p.unit_price_centimes FROM service_price p
                        WHERE p.service_id = s.id AND p.effective_from <= current_date
                        ORDER BY p.effective_from DESC LIMIT 1), 0) = 0
      HAVING count(*) > 0

      UNION ALL
      -- A client withholds at source but the rate is still zero, so every
      -- invoice to them would show a net equal to the total.
      SELECT 'withholding_unset', count(*)::text, NULL, NULL
        FROM company c
       WHERE ${isAdmin} AND c.retenue_source
         AND coalesce((SELECT rate_bp FROM fiscal_rate
                        WHERE key = 'retenue_source_tva' AND effective_from <= current_date
                        ORDER BY effective_from DESC LIMIT 1), 0) = 0
      HAVING count(*) > 0

      UNION ALL
      -- One administrator is one lost password away from a locked door.
      SELECT 'single_admin', count(*)::text, NULL, NULL
        FROM app_user u
       WHERE ${isAdmin} AND u.role = 'admin' AND u.is_active
      HAVING count(*) = 1

      UNION ALL
      -- Team members still on the password the installer generated.
      SELECT 'initial_passwords', count(*)::text, NULL, NULL
        FROM app_user u
       WHERE ${isAdmin} AND u.is_active AND u.is_assignable AND u.must_change_password
      HAVING count(*) > 0

      UNION ALL
      -- A retainer whose monthly draft was never made though its billing day
      -- has passed. Nothing was billed, so nothing will be paid.
      SELECT 'retainer_undrafted', count(*)::text, NULL, min(c.name)
        FROM retainer r
        JOIN company c ON c.id = r.company_id
       WHERE ${isModerator}
         AND r.status = 'active'
         AND r.billing_day < extract(day FROM current_date)
         AND app.retainer_term_end(r.start_date, r.term_months, r.auto_renew, r.end_date) > current_date
         AND NOT EXISTS (
           SELECT 1 FROM document d
            WHERE d.retainer_id = r.id
              AND d.retainer_period = to_char(current_date, 'YYYY-MM'))
      HAVING count(*) > 0

      UNION ALL
      -- A draft that was made and never issued. Until it has a number it is
      -- not an invoice and the client owes nothing.
      SELECT 'retainer_unissued', count(*)::text, NULL, min(c.name)
        FROM document d
        JOIN retainer r ON r.id = d.retainer_id
        JOIN company c ON c.id = d.company_id
       WHERE ${isModerator}
         AND d.status = 'brouillon'
         AND d.retainer_period IS NOT NULL
         AND d.issue_date < current_date
      HAVING count(*) > 0

      UNION ALL
      -- Out of the committed term and inside the renewal window. This is the
      -- moment a client actually leaves.
      SELECT 'retainer_renewal', count(*)::text, NULL, min(c.name)
        FROM retainer r
        JOIN company c ON c.id = r.company_id
       WHERE ${isModerator}
         AND r.status = 'active'
         AND NOT app.retainer_in_committed_term(r.start_date, r.term_months)
         AND app.retainer_term_end(r.start_date, r.term_months, r.auto_renew, r.end_date)
             <= current_date + 30
      HAVING count(*) > 0

      UNION ALL
      /*
       * An active client nobody has spoken to in a month.
       *
       * THIS WAS THE ONE BRANCH HERE WITHOUT A ROLE GATE, and it returns
       * min(c.name) -- a client's name -- so "Needs attention" was quietly
       * showing every member which client had gone quiet. That page is one a
       * member keeps, which made it the back door out of the team space: the
       * client list could be closed, the dashboard closed, the projects closed,
       * and a client's name would still appear on their own home screen.
       *
       * Chasing a quiet client is management's job anyway. Gated to the two
       * people whose job it is.
       */
      SELECT 'gone_quiet', count(*)::text, NULL, min(c.name)
        FROM company c
       WHERE ${isModerator} AND c.status = 'client'
         AND NOT EXISTS (SELECT 1 FROM interaction i
                          WHERE i.company_id = c.id
                            AND i.occurred_at > now() - interval '30 days')
      HAVING count(*) > 0
    `);

    const by = new Map(result.rows.map((r) => [r.kind, r]));
    const count = (k: string) => Number(by.get(k)?.n ?? 0);
    const items: AttentionItem[] = [];

    const push = (
      kind: string,
      severity: Severity,
      title: (n: number) => string,
      detail: (n: number, row?: Row) => string,
      href: string,
    ) => {
      const n = count(kind);
      if (n > 0) {
        items.push({ id: kind, severity, title: title(n), detail: detail(n, by.get(kind)), href });
      }
    };

    const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

    push('my_overdue', 'now',
      (n) => `${n} of your ${plural(n, 'tasks is', 'tasks are')} overdue`,
      (_n, row) => row?.detail ? `Oldest was due ${row.detail}.` : 'Past the due date.',
      '/my-work');

    push('my_today', 'now',
      (n) => `${n} of your tasks ${plural(n, 'is', 'are')} due today`,
      () => 'Due before the end of the day.',
      '/my-work');

    push('to_sign_off', 'now',
      (n) => `${n} ${plural(n, 'task is', 'tasks are')} waiting for your sign-off`,
      () => 'Someone has said they are done and is waiting on you to confirm it.',
      '/my-work');

    push('my_submitted', 'soon',
      (n) => `${n} of your ${plural(n, 'task is', 'tasks are')} waiting to be signed off`,
      () => 'Nothing for you to do — Mohamed Amine or Amin has to confirm it.',
      '/my-work');

    /*
     * The delivery queue, above the money.
     *
     * Deliberate: an invoice can be chased tomorrow, and work that is late or
     * belongs to nobody gets worse every day it is not looked at.
     */
    push('team_overdue', 'now',
      (n) => `${n} ${plural(n, 'task is', 'tasks are')} overdue across the team`,
      (n, row) =>
        row?.ref
          ? `${row.ref}${n > 1 ? ' among them' : ''}${row.detail ? `, oldest due ${row.detail}` : ''}.`
          : 'Assigned, past the due date, not finished.',
      '/tasks');

    push('overdue_projects', 'now',
      (n) => `${n} ${plural(n, 'project is', 'projects are')} past the delivery date`,
      (n, row) =>
        row?.ref
          ? `${row.ref}${n > 1 ? ' among them' : ''}${row.detail ? `, due ${row.detail}` : ''}.`
          : 'Still active and past its date.',
      '/projects');

    push('blocked_tasks', 'now',
      (n) => `${n} ${plural(n, 'task is', 'tasks are')} blocked`,
      (n, row) =>
        row?.ref
          ? `Somebody has stopped and said why — ${row.ref}${n > 1 ? ' among them' : ''}.`
          : 'Somebody has stopped and said why.',
      '/tasks');

    push('unassigned_tasks', 'soon',
      (n) => `${n} ${plural(n, 'task belongs', 'tasks belong')} to nobody`,
      (n, row) =>
        row?.detail
          ? `Nothing will happen until somebody is named. Oldest raised ${row.detail}.`
          : 'Nothing will happen until somebody is named.',
      '/tasks');

    push('projects_no_lead', 'soon',
      (n) => `${n} live ${plural(n, 'project has', 'projects have')} no lead`,
      (n, row) =>
        row?.ref
          ? `Nobody is accountable for it — ${row.ref}${n > 1 ? ' among them' : ''}.`
          : 'Nobody is accountable for it.',
      '/projects');

    push('overdue_invoices', 'now',
      (n) => `${n} ${plural(n, 'invoice is', 'invoices are')} overdue`,
      (_n, row) =>
        row?.detail
          ? `${(Number(row.detail) / 100).toFixed(2).replace('.', ',')} DH outstanding past its due date.`
          : 'Past the due date and unpaid.',
      '/finance');

    push('stale_drafts', 'soon',
      (n) => `${n} ${plural(n, 'draft has', 'drafts have')} been sitting for over a week`,
      () => 'A draft has no number and no legal standing until it is issued.',
      '/documents');

    push('retainer_undrafted', 'now',
      (n) => `${n} ${plural(n, 'retainer has', 'retainers have')} not been billed this month`,
      (_n, row) =>
        row?.ref
          ? `The billing day has passed and no draft exists — ${row.ref} among them.`
          : 'The billing day has passed and no draft exists.',
      '/retainers');

    push('retainer_unissued', 'soon',
      (n) => `${n} retainer ${plural(n, 'draft is', 'drafts are')} waiting to be issued`,
      (_n, row) =>
        row?.ref
          ? `A draft has no number, so nothing is owed yet — ${row.ref} among them.`
          : 'A draft has no number, so nothing is owed yet.',
      '/documents');

    push('retainer_renewal', 'soon',
      (n) => `${n} ${plural(n, 'retainer is', 'retainers are')} up for renewal within 30 days`,
      (_n, row) =>
        row?.ref
          ? `Out of the committed term — this is when a client leaves. ${row.ref} among them.`
          : 'Out of the committed term — this is when a client leaves.',
      '/retainers');

    push('gone_quiet', 'soon',
      (n) => `${n} ${plural(n, 'client has', 'clients have')} gone quiet`,
      (_n, row) =>
        row?.ref
          ? `Nothing on the timeline for 30 days — ${row.ref} among them.`
          : 'Nothing recorded on the timeline for 30 days.',
      '/clients');

    push('unpriced_services', 'setup',
      (n) => `${n} ${plural(n, 'service is', 'services are')} still priced at 0 DH`,
      () => 'A quote built from these would total zero. Set your rates.',
      '/services');

    push('withholding_unset', 'setup',
      (n) => `${n} ${plural(n, 'client withholds', 'clients withhold')} VAT at source, but the rate is 0`,
      () => 'Their invoices will show a net equal to the total until you set it in System.',
      '/system');

    push('single_admin', 'setup',
      () => 'You are the only administrator',
      () => 'One lost password locks the agency out of Finance and invoicing. Promote a second.',
      '/team');

    push('initial_passwords', 'setup',
      (n) => `${n} ${plural(n, 'person is', 'people are')} still on the initial password`,
      () => 'Everyone who was given it can sign in as them.',
      '/team');

    const order: Record<Severity, number> = { now: 0, soon: 1, setup: 2 };
    return items.sort((a, b) => order[a.severity] - order[b.severity]);
  });
}

/** Just the count of things that genuinely need doing now. */
export function urgentCount(items: readonly AttentionItem[]): number {
  return items.filter((i) => i.severity === 'now').length;
}
