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
       WHERE ${isAdmin} AND u.is_active AND u.must_change_password
      HAVING count(*) > 0

      UNION ALL
      -- An active client nobody has spoken to in a month.
      SELECT 'gone_quiet', count(*)::text, NULL, min(c.name)
        FROM company c
       WHERE c.status = 'client'
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
