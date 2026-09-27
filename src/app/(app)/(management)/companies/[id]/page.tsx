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
import { forDateTimeField, formatDateTime, paragraphs, whatsappLink } from '@/lib/format';
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
import { InteractionForm } from './InteractionForm';
import {
  RelationshipSections,
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
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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
             p.due_date::text,
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
             r.billing_day, r.end_date::text
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
                 d.total_incl_vat::text, d.net_to_collect::text, d.paid_at::text
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

    const relationship: Relationship = {
      projects: projects.rows,
      deals: deals.rows,
      retainers: retainers.rows,
      documents: documents.rows,
      threads: threads.rows,
    };

    return { record, contacts, timeline, accounts: accounts.rows, relationship };
  });

  const files = await listAttachments('company', id);

  if (!data) notFound();
  const { record, contacts, timeline, accounts, relationship } = data;

  const addContact = createContactAction.bind(null, record.id);
  const addInteraction = createInteractionAction.bind(null, record.id);

  return (
    <>
      <PageHeader
        eyebrow="Client record"
        title={record.name}
        actions={
          <>
            <ButtonLink href={`/companies/${record.id}/edit`} inverse>
              Edit
            </ButtonLink>
            <ButtonLink href="/clients" inverse>
              Back to pipeline
            </ButtonLink>
          </>
        }
      />

      {/* --- Stage: one click to move along the pipeline --------------------- */}
      <div className="flex flex-wrap items-center gap-3">
        <Status value={record.status} />
        <span className="label" style={{ opacity: 0.52 }}>
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

      {record.engagementSummary && (
        <p className="prose-vixart mt-8 text-lg">{record.engagementSummary}</p>
      )}

      {/* --- Identity ------------------------------------------------------- */}
      <div className="mt-10 grid grid-cols-1 gap-x-10 md:grid-cols-2">
        <div>
          <h2 className="label border-b border-void pb-2">Identity</h2>
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
          <h2 className="label border-b border-void pb-2">Legal identifiers</h2>
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

      {/*
        --- The relationship ------------------------------------------------

        Directly under the identity, and above the contacts, because this is
        what somebody opening a client came for: what we are doing for them,
        what has been sold, what is owed, and what has been said. Their
        telephone numbers matter less often than any of it.
      */}
      <RelationshipSections relationship={relationship} isAdmin={isAdmin} />

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
                          className="label border border-void px-2 py-1 hover:bg-void hover:text-pure"
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
                    <summary className="label cursor-pointer" style={{ opacity: 0.52 }}>
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
                    className="absolute top-2 -left-[29px] h-2 w-2 border border-void bg-pure"
                  />
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="label">{INTERACTION_KIND_LABELS[entry.kind] ?? entry.kind}</span>
                    <span className="code" style={{ opacity: 0.52 }}>
                      {formatDateTime(entry.occurredAt)}
                    </span>
                    <span className="label" style={{ opacity: 0.52 }}>
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
            accounts={accounts}
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
                Archiving keeps everything and takes the client out of every list and
                picker. That is almost always what you want: a client with an invoice
                or a conversation cannot be deleted at all, because both are records.
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
              <span className="label block" style={{ opacity: 0.68 }}>
                Type “{record.name}” to confirm
              </span>
              <input
                id="confirmation"
                name="confirmation"
                required
                autoComplete="off"
                className="mt-1.5 w-72 border border-void bg-pure px-3 py-2.5 text-[15px] focus:border-[3px] focus:px-[10px] focus:py-[8px] focus:outline-none"
              />
            </label>
            <button type="submit" className="btn">
              Delete permanently
            </button>
          </form>
        </Section>
      )}

      <p className="mt-16 border-t border-void/10 pt-6">
        <Link href="/clients" className="label underline underline-offset-4">
          Back to pipeline
        </Link>
      </p>
    </>
  );
}
