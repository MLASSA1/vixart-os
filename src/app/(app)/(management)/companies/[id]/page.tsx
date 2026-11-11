import { asc, desc, eq, sql } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { auth } from '@/auth';
import { ClientAccess } from './ClientAccess';
import { ButtonLink, Empty, Field, PageHeader, Section, Status } from '@/components/ui';
import { company, contact, interaction } from '@/db/schema';
import { COMPANY_STAGES, INTERACTION_KIND_LABELS } from '@/lib/labels';
import { withUser } from '@/db/session';
import { Attachments } from '@/components/Attachments';
import { listAttachments, uploadAttachmentAction } from '@/lib/attachment-actions';
import { casablancaDay, forDateTimeField, formatDate, formatDateTime, paragraphs, whatsappLink } from '@/lib/format';
import { formatMAD } from '@/lib/money';
import { paymentHabits, summariseBilling } from '@/lib/client-relationship';
import { INVOICE_PAYMENT_METHOD_FR } from '@/lib/labels';
import {
  createContactAction,
  createInteractionAction,
  deleteCompanyAction,
  deleteContactAction,
  deleteInteractionAction,
  setCompanyArchivedAction,
  setStatusAction,
  updateContactAction,
} from '../actions';
import { ContactForm } from './ContactForm';
import { ClientPayments } from './ClientPayments';
import { recordClientPaymentAction, reversePaymentAction } from '../../documents/actions';
import { InteractionForm } from './InteractionForm';
import {
  ConversationsSection,
  DealsSection,
  DocumentsSection,
  ProjectsSection,
  RetainersSection,
  type Relationship,
  type RelatedDeal,
  type RelatedDocument,
  type RelatedProject,
  type RelatedRetainer,
  type RelatedThread,
} from './Relationship';

export const dynamic = 'force-dynamic';

export default async function ClientPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const wanted = await searchParams;
  const session = await auth();
  const isAdmin = session?.user.role === 'admin';
  // Opening a client account is a moderator's job as well as an admin's: it is
  // account management for a relationship they already run.
  const canModerate = isAdmin || session?.user.role === 'moderator';
  const currentUserId = session?.user.id;

  const data = await withUser(async (tx) => {
    const rows = await tx.select().from(company).where(eq(company.id, id)).limit(1);
    const record = rows[0];
    if (!record) return null;

    const contacts = await tx
      .select()
      .from(contact)
      .where(eq(contact.companyId, id))
      .orderBy(desc(contact.isPrimary), asc(contact.fullName));

    const timeline = await tx
      .select()
      .from(interaction)
      .where(eq(interaction.companyId, id))
      .orderBy(desc(interaction.occurredAt));

    // Which of these people can sign in, and what state their account is in.
    // Read here rather than per-contact: one query, and the section below
    // needs it whether or not anybody has an account yet.
    const accounts = await tx.execute<{
      contact_id: string; is_active: boolean; must_change_password: boolean;
      last_sign_in_at: string | null; initial_password_expires_at: string | null;
    }>(sql`
      SELECT a.contact_id, a.is_active, a.must_change_password,
             a.last_sign_in_at::text, a.initial_password_expires_at::text
        FROM client_account a
        JOIN contact c ON c.id = a.contact_id
       WHERE c.company_id = ${id}
    `);

    /*
     * THE RELATIONSHIP, which this page did not assemble.
     *
     * It showed who the client is and said nothing about what we are doing for
     * them or what they owe — so a client with a live project and an unpaid
     * invoice looked, from their own page, exactly like one we had never worked
     * for. Staff reconstructed it by going to /projects and scanning, then
     * /documents and scanning again, which is how work and money get overlooked
     * by the person best placed to notice.
     *
     * Five queries rather than one join: they are independent lists, each
     * ordered differently, and a single query producing their cross product
     * would have to be unpicked in TypeScript afterwards.
     */
    const projects = await tx.execute<RelatedProject>(sql`
      SELECT p.id::text, p.name, p.status, p.archived_at::text,
             p.due_date::text, p.start_date::text, p.created_at::text,
             pr.percent, pr.done, pr.total,
             u.full_name AS lead
        FROM project p
        LEFT JOIN app_user u ON u.id = p.lead_id
        -- LATERAL rather than calling it twice in the select list, which is two
        -- scans of the task table per project for one set of numbers.
        LEFT JOIN LATERAL app.project_progress(p.id) pr ON true
       WHERE p.company_id = ${id}
       ORDER BY (p.archived_at IS NOT NULL),
                CASE p.status WHEN 'active' THEN 0 WHEN 'planned' THEN 1
                              WHEN 'on_hold' THEN 2 ELSE 3 END,
                p.due_date NULLS LAST, lower(p.name)
    `);

    const deals = await tx.execute<RelatedDeal>(sql`
      SELECT d.id::text, d.title, d.stage, d.value_centimes::text,
             d.expected_close_date::text, d.closed_at::text,
             u.full_name AS owner
        FROM deal d
        LEFT JOIN app_user u ON u.id = d.owner_id
       WHERE d.company_id = ${id}
       ORDER BY (d.closed_at IS NOT NULL), d.created_at DESC
    `);

    const retainers = await tx.execute<RelatedRetainer>(sql`
      SELECT r.id::text, r.label, r.monthly_centimes::text, r.status,
             r.billing_day, r.end_date::text, r.auto_renew
        FROM retainer r
       WHERE r.company_id = ${id}
       ORDER BY (r.status <> 'active'), lower(r.label)
    `);

    /*
     * Only for an administrator, and not merely hidden afterwards.
     *
     * `document` is admin-only at the policy layer, so a moderator running this
     * would get an empty list — and an empty invoices section reads as "this
     * client has never been invoiced", which is a lie told confidently. Not
     * asking is the honest version of not being allowed to know.
     */
    const documents = isAdmin
      ? await tx.execute<RelatedDocument>(sql`
          SELECT d.id::text, d.doc_type, d.status, d.number, d.issue_date::text,
                 d.total_incl_vat::text, d.net_to_collect::text, d.paid_at::text,
                 d.due_date::text, d.payment_method,
                 -- Deposits and part-payments, so a 50% advance is not shown as owed.
                 coalesce((SELECT sum(p.amount_centimes) FROM document_payment p
                            WHERE p.document_id = d.id), 0)::text AS paid
            FROM document d
           WHERE d.company_id = ${id}
           ORDER BY d.issue_date DESC NULLS LAST, d.created_at DESC
        `)
      : { rows: [] as RelatedDocument[] };

    const threads = await tx.execute<RelatedThread>(sql`
      SELECT t.id::text, t.kind, t.title,
             (SELECT count(*)::int FROM message m WHERE m.thread_id = t.id) AS messages,
             (SELECT max(m.created_at)::text FROM message m WHERE m.thread_id = t.id) AS last_at
        FROM thread t
       WHERE t.company_id = ${id}
         -- The client's own conversation and our channel about them. Nothing
         -- else is about this company.
         AND t.kind IN ('company', 'support')
       ORDER BY t.kind
    `);

    /*
     * When they became a client: the first time the stage moved to client, which
     * the activity log records (the company_activity trigger). A company created
     * straight in as a client never "moved", so its creation date stands in.
     */
    const becameClient = await tx.execute<{ at: string | null }>(sql`
      SELECT min(created_at)::text AS at FROM activity
       WHERE entity_type = 'company' AND entity_id = ${id} AND action = 'moved to client'
    `);

    /*
     * Every payment this client has made, and every reversal — admin only, like
     * the documents they belong to. Nothing in it is ever deleted (0083).
     */
    const paymentRows = isAdmin
      ? (await tx.execute<{
          [k: string]: unknown;
          id: string; amount: string; method: string; paid_on: string; note: string | null;
          reverses_id: string | null; reversed_on: string | null; recorded_by: string | null;
          document_id: string; number: string | null;
        }>(sql`
          SELECT p.id::text, p.amount_centimes::text AS amount, p.method, p.paid_on::text, p.note,
                 p.reverses_id::text,
                 (SELECT r.paid_on::text FROM document_payment r WHERE r.reverses_id = p.id) AS reversed_on,
                 u.full_name AS recorded_by, d.id::text AS document_id, d.number
            FROM document_payment p
            JOIN document d ON d.id = p.document_id
            LEFT JOIN app_user u ON u.id = p.created_by_id
           WHERE d.company_id = ${id}
           ORDER BY p.paid_on DESC, p.created_at DESC
        `)).rows
      : [];
    const isOwner = isAdmin
      ? Boolean((await tx.execute<{ owner: boolean }>(sql`SELECT app.is_owner() AS owner`)).rows[0]?.owner)
      : false;

    const relationship: Relationship = {
      projects: projects.rows,
      deals: deals.rows,
      retainers: retainers.rows,
      documents: documents.rows,
      threads: threads.rows,
    };

    return {
      record, contacts, timeline, accounts: accounts.rows, relationship,
      becameClientAt: becameClient.rows[0]?.at ?? null,
      paymentRows,
      isOwner,
    };
  });

  const files = await listAttachments('company', id);

  if (!data) notFound();
  const { record, contacts, timeline, accounts, relationship, becameClientAt, paymentRows, isOwner } = data;

  const addContact = createContactAction.bind(null, record.id);
  const addInteraction = createInteractionAction.bind(null, record.id);

  /*
   * THE SUMMARY. What somebody opening a client wants before anything else —
   * who to call, what is under way, and what they owe — kept above the tabs so
   * it is on screen whichever tab is open. The page used to be four screens of
   * sections with the money a screen and a half down.
   */
  const today = casablancaDay();
  const money = summariseBilling(relationship.documents);
  const habits = paymentHabits(
    relationship.documents.map((d) => ({
      ...d,
      // The Casablanca day it was paid, made here on the server: see format.ts.
      paid_day: d.paid_at ? casablancaDay(d.paid_at) : null,
    })),
    today,
  );
  const main = contacts[0] ?? null;
  const mainWhatsapp = main ? whatsappLink(main.whatsapp) : null;
  const active = relationship.projects.filter((p) => p.status === 'active' && !p.archived_at);
  const nextDue = active.map((p) => p.due_date).filter((d): d is string => Boolean(d)).sort()[0] ?? null;

  /* KEY DATES — each from a record, never estimated. */
  const projectDays = relationship.projects
    .map((p) => p.start_date ?? (p.created_at ? casablancaDay(p.created_at) : null))
    .filter((d): d is string => Boolean(d))
    .sort();
  const clientSince = becameClientAt ?? (record.status === 'client' ? String(record.createdAt) : null);
  const renewal =
    relationship.retainers
      .filter((r) => r.status === 'active' && r.end_date && r.end_date >= today)
      .sort((a, b) => String(a.end_date).localeCompare(String(b.end_date)))[0] ?? null;

  /*
   * WHAT IS MISSING. Amin: "no missing data". The production audit found ten
   * of thirteen clients with no contact person at all and eleven with no ICE —
   * gaps nobody saw until an invoice needed them. Each is named here, with
   * why it matters and the link that fixes it. Nothing is guessed: a missing
   * detail is shown as missing, never filled in.
   */
  const reachable = contacts.some((c) => c.phone || c.whatsapp || c.email);
  const missing = [
    !record.isIndividual && !record.ice
      ? { what: 'ICE', why: 'required on every invoice to a company', href: `/companies/${record.id}/edit` }
      : null,
    !record.addressLine ? { what: 'Address', why: 'printed on quotes and invoices', href: `/companies/${record.id}/edit` } : null,
    !record.city ? { what: 'City', why: 'printed on quotes and invoices', href: `/companies/${record.id}/edit` } : null,
    contacts.length === 0
      ? { what: 'A contact person', why: 'nobody to call or write to', href: '?tab=contacts' }
      : !contacts.some((c) => c.isPrimary)
        ? { what: 'A main contact', why: 'who to call first', href: '?tab=contacts' }
        : null,
    contacts.length > 0 && !reachable
      ? { what: 'A phone, WhatsApp or email', why: 'no way to reach anyone here', href: '?tab=contacts' }
      : null,
  ].filter((m): m is { what: string; why: string; href: string } => m !== null);

  /* WHERE TO FIND THEM ONLINE (0082), with the website that was already here. */
  const links = [
    { label: 'Website', url: record.website },
    { label: 'Instagram', url: record.instagramUrl },
    { label: 'Facebook', url: record.facebookUrl },
    { label: 'Google Maps', url: record.mapsUrl },
    { label: 'Booking page', url: record.bookingUrl },
  ].filter((l): l is { label: string; url: string } => Boolean(l.url));

  /*
   * THE TABS, in the address (?tab=projects), so a tab can be bookmarked,
   * sent to a colleague and reached with the browser's back button. Quotes &
   * invoices exists only for an administrator — asked for by anybody else, the
   * address falls back to the overview rather than to an empty tab.
   */
  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'projects', label: 'Projects', count: relationship.projects.length },
    ...(isAdmin ? [{ key: 'billing', label: 'Quotes & invoices', count: relationship.documents.length }] : []),
    { key: 'contacts', label: 'Contacts', count: contacts.length },
    { key: 'timeline', label: 'Timeline', count: timeline.length },
    { key: 'files', label: 'Files', count: files.length },
    { key: 'settings', label: 'Settings' },
  ];
  const tab = tabs.some((t) => t.key === wanted.tab) ? (wanted.tab as string) : 'overview';

  return (
    <>
      <PageHeader
        title={record.name}
        intro={[record.city, record.legalName && record.legalName !== record.name ? record.legalName : null].filter(Boolean).join(' · ') || undefined}
        actions={
          <>
            {isAdmin && (
              <ButtonLink href={`/documents/new?client=${record.id}&type=devis`}>New quote</ButtonLink>
            )}
            <ButtonLink href={`/companies/${record.id}/edit`} inverse>
              Edit
            </ButtonLink>
          </>
        }
      />

      {/* --- Stage: one click to move along the pipeline --------------------- */}
      <div className="flex flex-wrap items-center gap-3">
        <Status value={record.status} />
        <span className="label">
          move to
        </span>
        {COMPANY_STAGES.filter((s) => s.value !== record.status).map((s) => (
          <form key={s.value} action={setStatusAction}>
            <input type="hidden" name="companyId" value={record.id} />
            <input type="hidden" name="status" value={s.value} />
            <button type="submit" className="btn btn-inverse">
              {s.label}
            </button>
          </form>
        ))}
      </div>


      {/* --- The summary: always on screen, whichever tab is open ----------- */}
      <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="card px-5 py-4">
          <p className="label">Main contact</p>
          {main ? (
            <>
              <p className="mt-1 font-semibold">{main.fullName}</p>
              {main.roleTitle && <p className="hint">{main.roleTitle}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13.5px]">
                {main.phone && <a href={`tel:${main.phone.replace(/\s+/g, '')}`} className="code underline-offset-4 hover:underline">{main.phone}</a>}
                {mainWhatsapp && <a href={mainWhatsapp} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">WhatsApp</a>}
                {main.email && <a href={`mailto:${main.email}`} className="underline underline-offset-4">Email</a>}
              </div>
            </>
          ) : (
            <p className="hint mt-1">
              Nobody yet. <Link href="?tab=contacts" className="underline underline-offset-4">Add a contact</Link>
            </p>
          )}
        </div>

        <div className="card px-5 py-4">
          <p className="label">Work</p>
          <p className="mt-1">
            <span className="kpi-sm">{active.length}</span>{' '}
            <span className="hint">active project{active.length === 1 ? '' : 's'}</span>
          </p>
          <p className="hint mt-1">
            {nextDue ? <>Next due {formatDate(nextDue)}</> : 'Nothing due'}
            {relationship.projects.length > active.length && <> · {relationship.projects.length} in all</>}
          </p>
        </div>

        {/* The money, for an administrator only — never rendered otherwise. */}
        {isAdmin && (
          <div className={`card px-5 py-4 ${money.outstanding > 0n ? 'tone-warn' : ''}`}>
            <p className="label" style={money.outstanding > 0n ? { color: 'inherit' } : undefined}>
              {money.outstanding < 0n ? 'In credit' : 'Still owed'}
            </p>
            <p className={`kpi-sm mt-1 ${money.outstanding === 0n ? 'is-zero' : ''}`}>
              {formatMAD(money.outstanding < 0n ? -money.outstanding : money.outstanding)}
            </p>
            <p className="mt-1 text-[13px]" style={{ opacity: 0.85 }}>
              {formatMAD(money.billed)} billed · {formatMAD(money.collected)} paid
              {money.credited > 0n && <> · {formatMAD(money.credited)} credited</>}
              {habits.overdue.count > 0 && <> · <strong>{habits.overdue.count} overdue</strong></>}
            </p>
          </div>
        )}
      </div>

      {/* --- The tabs -------------------------------------------------------- */}
      <nav aria-label="Client sections" className="mt-8 flex flex-wrap gap-x-1 gap-y-1 border-b border-void/10">
        {tabs.map((t) => {
          const on = t.key === tab;
          return (
            <Link
              key={t.key}
              href={t.key === 'overview' ? `/companies/${record.id}` : `?tab=${t.key}`}
              aria-current={on ? 'page' : undefined}
              className={`-mb-px border-b-2 px-3 py-2.5 text-[14px] transition-colors ${
                on ? 'border-accent-ink font-semibold text-void' : 'border-transparent text-void/60 hover:text-void'
              }`}
            >
              {t.label}
              {t.count !== undefined && t.count > 0 && <span className="ml-1.5 text-[12px]">{t.count}</span>}
            </Link>
          );
        })}
      </nav>

      {tab === 'overview' && (
        <>
          {missing.length > 0 && (
            <section className="tone-warn mt-6 rounded-[14px] px-5 py-4">
              <p className="font-semibold">
                {missing.length === 1 ? 'One detail is missing' : `${missing.length} details are missing`}
              </p>
              <ul className="mt-2 space-y-1 text-[14px]">
                {missing.map((m) => (
                  <li key={m.what}>
                    <Link href={m.href} className="font-semibold underline underline-offset-4">{m.what}</Link>
                    <span> — {m.why}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
      {record.engagementSummary && (
        <p className="prose-vixart mt-8 text-lg">{record.engagementSummary}</p>
      )}

      {/* --- Identity ------------------------------------------------------- */}
      <div className="mt-10 grid grid-cols-1 gap-x-10 md:grid-cols-2">
        <div>
          <h2 className="label border-b border-void/40 pb-2">Identity</h2>
          <div className="mt-2">
            <Field label="Registered name" value={record.legalName} />
            <Field label="City" value={record.city} />
            <Field label="Address" value={record.addressLine} />
            <Field
              label="Website"
              value={
                record.website ? (
                  <a
                    href={record.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-4"
                  >
                    {record.website.replace(/^https?:\/\//, '')}
                  </a>
                ) : null
              }
            />
          </div>
        </div>

        <div className="mt-10 md:mt-0">
          <h2 className="label border-b border-void/40 pb-2">Legal identifiers</h2>
          <div className="mt-2">
            <Field label="ICE" value={record.ice} />
            <Field label="Tax ID (IF)" value={record.identifiantFiscal} />
            <Field label="Trade register" value={record.registreCommerce} />
            <Field
              label="Withholding at source"
              value={record.retenueSource ? 'YES — art. 117 bis' : 'No'}
            />
          </div>
          {!record.ice && (
            <p className="prose-vixart mt-3 text-[15px]" style={{ opacity: 0.52 }}>
              No ICE on file. It is required on any invoice issued to this client.
            </p>
          )}
        </div>
      </div>


          <div className="mt-10 grid grid-cols-1 gap-x-10 gap-y-10 md:grid-cols-2">
            <div>
              <h2 className="label border-b border-void/40 pb-2">Online</h2>
              <div className="mt-2">
                {links.length === 0 ? (
                  <p className="hint mt-2">
                    No links yet. <Link href={`/companies/${record.id}/edit`} className="underline underline-offset-4">Add Instagram, Facebook, Maps or a booking page</Link>
                  </p>
                ) : (
                  links.map((l) => (
                    <Field
                      key={l.label}
                      label={l.label}
                      value={
                        <a href={l.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
                          {l.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').slice(0, 40)}
                        </a>
                      }
                    />
                  ))
                )}
              </div>
            </div>

            <div>
              <h2 className="label border-b border-void/40 pb-2">Key dates</h2>
              <div className="mt-2">
                <Field label="Client since" value={clientSince ? formatDate(clientSince) : record.status === 'client' ? 'Not recorded' : 'Not a client yet'} />
                <Field label="On record since" value={formatDate(record.createdAt)} />
                <Field label="First project" value={projectDays[0] ? formatDate(projectDays[0]) : 'None yet'} />
                <Field label="Latest project" value={projectDays.length > 1 ? formatDate(projectDays[projectDays.length - 1]!) : projectDays[0] ? 'The first one' : 'None yet'} />
                <Field
                  label="Contract"
                  value={renewal ? `${renewal.auto_renew ? 'Renews' : 'Ends'} ${formatDate(renewal.end_date)} — ${renewal.label}` : 'No running contract'}
                />
              </div>
            </div>

            {isAdmin && (
              <div className="md:col-span-2">
                <h2 className="label border-b border-void/40 pb-2">How they pay</h2>
                <div className="mt-2 grid grid-cols-1 gap-x-10 md:grid-cols-2">
                  <div>
                    <Field
                      label="Usually by"
                      value={habits.usualMethod ? `${INVOICE_PAYMENT_METHOD_FR[habits.usualMethod.method] ?? habits.usualMethod.method} (${habits.usualMethod.count} of ${habits.usualMethod.of})` : 'No issued invoice yet'}
                    />
                    <Field
                      label="Time to pay"
                      value={habits.daysToPay === null ? 'Not enough history yet' : `About ${habits.daysToPay} day${habits.daysToPay === 1 ? '' : 's'} after the invoice`}
                    />
                    <Field
                      label="Against the due date"
                      value={
                        habits.daysLate === null ? 'Not enough history yet'
                          : habits.daysLate > 0 ? `Usually ${habits.daysLate} day${habits.daysLate === 1 ? '' : 's'} late`
                          : habits.daysLate < 0 ? `Usually ${-habits.daysLate} day${habits.daysLate === -1 ? '' : 's'} early`
                          : 'On time'
                      }
                    />
                  </div>
                  <div>
                    <Field label="Paid all time" value={formatMAD(money.collected)} />
                    <Field
                      label="Overdue now"
                      value={habits.overdue.count === 0 ? 'Nothing' : `${formatMAD(habits.overdue.owed)} on ${habits.overdue.count} invoice${habits.overdue.count === 1 ? '' : 's'}`}
                    />
                    <Field label="Based on" value={`${habits.paidCount} paid invoice${habits.paidCount === 1 ? '' : 's'}`} />
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'projects' && (
        <>
          <ProjectsSection projects={relationship.projects} />
          <RetainersSection retainers={relationship.retainers} />
          <DealsSection deals={relationship.deals} />
        </>
      )}

      {tab === 'billing' && isAdmin && (
        <>
          <ClientPayments
            openInvoices={relationship.documents
              .filter((d) => d.doc_type === 'facture' && d.status === 'emis' && d.number)
              .map((d) => ({
                id: d.id,
                number: d.number as string,
                remaining: (BigInt(d.net_to_collect ?? d.total_incl_vat) - BigInt(d.paid ?? '0')).toString(),
              }))
              .filter((d) => BigInt(d.remaining) > 0n)}
            history={paymentRows.map((p) => ({
              id: p.id,
              amount: p.amount,
              method: p.method,
              paidOn: formatDate(p.paid_on),
              note: p.note,
              recordedBy: p.recorded_by,
              reversesId: p.reverses_id,
              reversedOn: p.reversed_on ? formatDate(p.reversed_on) : null,
              invoice: { id: p.document_id, number: p.number },
            }))}
            today={today}
            canReverse={isOwner}
            record={recordClientPaymentAction}
            reverse={reversePaymentAction}
          />
          <DocumentsSection documents={relationship.documents} isAdmin={isAdmin} companyId={record.id} />
        </>
      )}

      {tab === 'contacts' && (
        <>
      {/* --- Contacts ------------------------------------------------------- */}
      <Section title={`Contacts — ${contacts.length}`}>
        {contacts.length === 0 ? (
          <Empty message="No contact recorded" />
        ) : (
          <ul className="border-t border-void/10">
            {contacts.map((person) => {
              const wa = whatsappLink(person.whatsapp);
              const editAction = updateContactAction.bind(null, record.id, person.id);
              return (
                <li key={person.id} className="border-b border-void/10 py-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                    <div>
                      <span className="font-semibold">{person.fullName}</span>
                      {person.isPrimary && (
                        <span className="label ml-3 border border-void px-2 py-0.5">
                          Primary
                        </span>
                      )}
                      {person.roleTitle && (
                        <p className="text-[15px]" style={{ opacity: 0.68 }}>
                          {person.roleTitle}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
                      {person.email && (
                        <a
                          href={`mailto:${person.email}`}
                          className="code underline underline-offset-4"
                        >
                          {person.email}
                        </a>
                      )}
                      {person.phone && <span className="code">{person.phone}</span>}
                      {wa && (
                        <a
                          href={wa}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="label border border-void px-2 py-1 hover:bg-void hover:text-night"
                        >
                          WhatsApp
                        </a>
                      )}
                    </div>
                  </div>

                  {person.notes && (
                    <p className="prose-vixart mt-1.5 text-[15px]" style={{ opacity: 0.68 }}>
                      {person.notes}
                    </p>
                  )}

                  <details className="mt-2">
                    <summary className="label cursor-pointer">
                      Edit
                    </summary>
                    <div className="border-l border-void/20 pl-4">
                      <ContactForm
                        action={editAction}
                        record={person}
                        submitLabel="Save contact"
                      />
                      <form action={deleteContactAction} className="mt-4">
                        <input type="hidden" name="companyId" value={record.id} />
                        <input type="hidden" name="contactId" value={person.id} />
                        <button type="submit" className="btn btn-inverse">
                          Delete this contact
                        </button>
                      </form>
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}

        <details className="mt-6">
          <summary className="btn btn-inverse cursor-pointer list-none">
            Add a contact
          </summary>
          <ContactForm action={addContact} submitLabel="Add contact" resetOnSuccess />
        </details>
      </Section>

        </>
      )}

      {tab === 'timeline' && (
        <>
      {/* --- Timeline ------------------------------------------------------- */}
      <Section title={`Timeline — ${timeline.length}`}>
        <InteractionForm
          action={addInteraction}
          defaultOccurredAt={forDateTimeField()}
        />

        {timeline.length === 0 ? (
          <div className="mt-6">
            <Empty message="Nothing recorded yet — this is what replaces WhatsApp memory" />
          </div>
        ) : (
          <ol className="mt-8 border-l border-void/20 pl-6">
            {timeline.map((entry) => {
              const mine = entry.authorId === currentUserId;
              return (
                <li key={entry.id} className="relative mb-8">
                  {/* Timeline marker — a square rule, not a coloured dot. */}
                  <span
                    aria-hidden="true"
                    className="absolute top-2 -left-[29px] h-2 w-2 border border-void bg-paper"
                  />
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="label">{INTERACTION_KIND_LABELS[entry.kind] ?? entry.kind}</span>
                    <span className="code" style={{ opacity: 0.52 }}>
                      {formatDateTime(entry.occurredAt)}
                    </span>
                    <span className="label">
                      {entry.authorName}
                    </span>
                  </div>

                  <p className="mt-1 font-semibold">{entry.title}</p>

                  {paragraphs(entry.body).map((p, i) => (
                    <p key={i} className="prose-vixart mt-1.5" style={{ opacity: 0.68 }}>
                      {p}
                    </p>
                  ))}

                  {(mine || isAdmin) && (
                    <form action={deleteInteractionAction} className="mt-2">
                      <input type="hidden" name="companyId" value={record.id} />
                      <input type="hidden" name="interactionId" value={entry.id} />
                      <button
                        type="submit"
                        className="label cursor-pointer underline underline-offset-4"
                        style={{ opacity: 0.52 }}
                      >
                        Delete
                      </button>
                    </form>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </Section>

          <ConversationsSection threads={relationship.threads} />
        </>
      )}

      {tab === 'files' && (
        <>
      {/* Contracts, briefs, signed quotes — anything that belongs to the client
          rather than to a single project. */}
      <Section title={`Files — ${files.length}`}>
        <Attachments
          action={uploadAttachmentAction.bind(null, 'company', record.id, `/companies/${record.id}`)}
          items={files.map((f) => ({
            id: f.id,
            originalName: f.originalName,
            mimeType: f.mimeType,
            sizeBytes: String(f.sizeBytes),
            caption: f.caption,
            uploaderName: null,
            createdAt: String(f.createdAt),
          }))}
          revalidate={`/companies/${record.id}`}
        />
      </Section>

        </>
      )}

      {tab === 'settings' && (
        <>
      {/* --- Internal notes ------------------------------------------------- */}
      {record.notes && (
        <Section title="Internal notes">
          {paragraphs(record.notes).map((p, i) => (
            <p key={i} className="prose-vixart mt-2">
              {p}
            </p>
          ))}
        </Section>
      )}

      {/* --- Client access: who at this company can sign in ------------------ */}
      {canModerate && (
        <Section title={`Client access — ${accounts.length}`}>
          <ClientAccess
            companyId={record.id}
            contacts={contacts.map((c) => ({
              id: c.id,
              fullName: c.fullName,
              email: c.email,
            }))}
            // The date is formatted here, on the server: see src/lib/format.ts
            // for why a client component does no date arithmetic of its own.
            accounts={accounts.map((a) => ({
              ...a,
              last_sign_in_label: a.last_sign_in_at ? formatDate(a.last_sign_in_at) : null,
            }))}
          />
        </Section>
      )}

      {/* --- Deletion: management only, name must be typed ------------------- */}
      {isAdmin && (
        <Section title={record.archivedAt ? 'Archived' : 'Archive or delete'}>
          {record.archivedAt ? (
            <>
              <p className="prose-vixart" style={{ opacity: 0.68 }}>
                This client is out of use. Everything is kept — documents, messages
                and figures — and it no longer appears in lists or pickers.
              </p>
              <form action={setCompanyArchivedAction} className="mt-4">
                <input type="hidden" name="companyId" value={record.id} />
                <input type="hidden" name="archived" value="0" />
                <button type="submit" className="btn btn-inverse">Bring it back</button>
              </form>
            </>
          ) : (
            <>
              <p className="prose-vixart" style={{ opacity: 0.68 }}>
                Archiving keeps everything but hides the client from every list. A client
                with an invoice or a conversation can only be archived, never deleted.
              </p>
              <form action={setCompanyArchivedAction} className="mt-4">
                <input type="hidden" name="companyId" value={record.id} />
                <input type="hidden" name="archived" value="1" />
                <button type="submit" className="btn">Archive this client</button>
              </form>
            </>
          )}

          <p className="prose-vixart mt-8" style={{ opacity: 0.68 }}>
            Deleting also removes its {contacts.length} contact(s) and its{' '}
            {timeline.length} timeline entries, and cannot be undone. It is refused
            outright if this client has any quote, invoice, or message.
          </p>
          <form action={deleteCompanyAction} className="mt-4 flex flex-wrap items-end gap-3">
            <input type="hidden" name="companyId" value={record.id} />
            <input type="hidden" name="expected" value={record.name} />
            <label className="block" htmlFor="confirmation">
              <span className="label block">
                Type “{record.name}” to confirm
              </span>
              <input
                id="confirmation"
                name="confirmation"
                required
                autoComplete="off"
                className="mt-1.5 w-72 border border-void/30 bg-surface px-3 py-2.5 text-[15px] focus:border-[3px] focus:px-[10px] focus:py-[8px] focus:outline-none"
              />
            </label>
            <button type="submit" className="btn">
              Delete permanently
            </button>
          </form>
        </Section>
      )}

        </>
      )}
    </>
  );
}
