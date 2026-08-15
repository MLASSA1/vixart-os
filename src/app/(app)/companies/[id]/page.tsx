import { asc, desc, eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { auth } from '@/auth';
import { ButtonLink, Empty, Field, PageHeader, Section, Status } from '@/components/ui';
import { company, contact, interaction } from '@/db/schema';
import { COMPANY_STAGES, INTERACTION_KIND_LABELS } from '@/lib/labels';
import { withUser } from '@/db/session';
import { forDateTimeField, formatDateTime, paragraphs, whatsappLink } from '@/lib/format';
import {
  createContactAction,
  createInteractionAction,
  deleteCompanyAction,
  deleteContactAction,
  deleteInteractionAction,
  setStatusAction,
  updateContactAction,
} from '../actions';
import { ContactForm } from './ContactForm';
import { InteractionForm } from './InteractionForm';

export const dynamic = 'force-dynamic';

export default async function ClientPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  const isAdmin = session?.user.role === 'admin';
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

    return { record, contacts, timeline };
  });

  if (!data) notFound();
  const { record, contacts, timeline } = data;

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

      {/* --- Deletion: management only, name must be typed ------------------- */}
      {isAdmin && (
        <Section title="Delete record">
          <p className="prose-vixart" style={{ opacity: 0.68 }}>
            Deleting this record also deletes its {contacts.length} contact(s) and its{' '}
            {timeline.length} timeline entries. This cannot be undone. Restore from a
            backup is the only way back.
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
