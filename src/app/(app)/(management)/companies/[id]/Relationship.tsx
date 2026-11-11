import Link from 'next/link';
import { Empty, Section } from '@/components/ui';
import { formatDate } from '@/lib/format';
import { formatMAD } from '@/lib/money';
import { summariseBilling } from '@/lib/client-relationship';
import {
  DEAL_STAGE_LABELS,
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_TYPE_LABELS,
  PROJECT_STATUS_LABELS,
} from '@/lib/labels';

/**
 * The whole relationship, on the client's own page.
 *
 * WHAT WAS WRONG. Opening a client showed their identity, their legal
 * identifiers, their contacts, a timeline, their files and their portal access —
 * and nothing about the work being done for them or the money they owe. A client
 * with a live project and an unpaid quote looked, from their own page,
 * indistinguishable from one we had never worked for. The only way to find out
 * was to go to /projects and scan it, then /documents and scan that.
 *
 * The cost is not inconvenience. It is that work and money get overlooked
 * precisely when somebody is looking at the client and would have caught it.
 *
 * ROLE-FILTERED BY NOT BEING RENDERED. `document` is admin-only at the policy
 * layer, so a moderator's query for invoices returns an empty list — and an
 * empty "Invoices" section reads as "this client has never been invoiced",
 * which is a lie told confidently. A section nobody may see is not rendered at
 * all, so the absence says nothing.
 *
 * EVERY ROW IS A LINK. The point is to get from here to the record, so nothing
 * below is a read-only summary of something you then have to go and find.
 */

export interface RelatedProject {
  [k: string]: unknown;
  id: string;
  name: string;
  status: string;
  archived_at: string | null;
  due_date: string | null;
  start_date?: string | null;
  created_at?: string;
  percent: number;
  done: number;
  total: number;
  lead: string | null;
}

export interface RelatedDeal {
  [k: string]: unknown;
  id: string;
  title: string;
  stage: string;
  value_centimes: string;
  expected_close_date: string | null;
  closed_at: string | null;
  owner: string | null;
}

export interface RelatedRetainer {
  [k: string]: unknown;
  id: string;
  label: string;
  monthly_centimes: string;
  status: string;
  billing_day: number;
  end_date: string | null;
  auto_renew?: boolean;
}

export interface RelatedDocument {
  [k: string]: unknown;
  id: string;
  doc_type: string;
  status: string;
  number: string | null;
  issue_date: string | null;
  total_incl_vat: string;
  net_to_collect: string | null;
  paid_at: string | null;
  due_date?: string | null;
  payment_method?: string | null;
  /** Received so far, in centimes. */
  paid?: string;
}

export interface RelatedThread {
  [k: string]: unknown;
  id: string;
  kind: string;
  title: string;
  messages: number;
  last_at: string | null;
}

export interface Relationship {
  projects: RelatedProject[];
  deals: RelatedDeal[];
  retainers: RelatedRetainer[];
  documents: RelatedDocument[];
  threads: RelatedThread[];
}

/** A quiet line of detail under a linked title. */
function Meta({ children }: { children: React.ReactNode }) {
  return (
    <p className="hint text-[12.5px]">{children}</p>
  );
}

function Row({
  href,
  title,
  aside,
  children,
  faded,
}: {
  href: string;
  title: string;
  aside?: React.ReactNode;
  children?: React.ReactNode;
  faded?: boolean;
}) {
  return (
    // A closed or archived row is set back by its TITLE only. Dimming the whole
    // row stacked under the already-quiet detail line and dropped it to 3.6:1;
    // the row says "Won" or "Archived" in words anyway.
    <li className="border-b border-void/[0.07] py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1">
        <div className="min-w-0">
          <Link href={href} className={`font-semibold underline-offset-2 hover:underline ${faded ? 'text-void/70' : ''}`}>
            {title}
          </Link>
          {children}
        </div>
        {aside && <div className="text-right text-[13px] tabular-nums">{aside}</div>}
      </div>
    </li>
  );
}

/*
 * FIVE SECTIONS, NOT ONE. The client page became a summary and tabs (Amin,
 * November 2026), so the work, the sales, the contracts, the money and the
 * conversations each go to the tab they belong in instead of one long scroll.
 * The rules below did not change: every row is a link, an absent owner is
 * named, and the money is never rendered for anybody but an administrator.
 */

export function ProjectsSection({ projects }: { projects: RelatedProject[] }) {
  return (
      <Section title={`Projects — ${projects.length}`}>
        {projects.length === 0 ? (
          <Empty message="No project for this client yet." />
        ) : (
          <ul>
            {projects.map((p) => {
              const archived = p.archived_at !== null;
              return (
                <Row
                  key={p.id}
                  href={`/projects/${p.id}`}
                  title={p.name}
                  faded={archived}
                  aside={
                    <>
                      <span className="font-semibold">{Number(p.percent)}%</span>
                      {Number(p.total) > 0 && (
                        <span className="block text-[12px]" style={{ opacity: 0.55 }}>
                          {p.done} of {p.total} tasks
                        </span>
                      )}
                    </>
                  }
                >
                  <Meta>
                    {archived ? 'Archived' : PROJECT_STATUS_LABELS[p.status] ?? p.status}
                    {p.lead ? ` · ${p.lead}` : ' · no lead'}
                    {p.due_date && ` · due ${formatDate(p.due_date)}`}
                  </Meta>
                </Row>
              );
            })}
          </ul>
        )}
      </Section>
  );
}

export function DealsSection({ deals }: { deals: RelatedDeal[] }) {
  return (
      <Section title={`Deals — ${deals.length}`}>
        {deals.length === 0 ? (
          <Empty message="No opportunity recorded for this client." />
        ) : (
          <ul>
            {deals.map((d) => (
              <Row
                key={d.id}
                href={`/deals/${d.id}`}
                title={d.title}
                faded={d.closed_at !== null}
                aside={formatMAD(BigInt(d.value_centimes))}
              >
                <Meta>
                  {DEAL_STAGE_LABELS[d.stage] ?? d.stage}
                  {/* The owner, or the absence of one. An opportunity nobody is
                      accountable for is the thing worth seeing here. */}
                  {d.owner ? ` · ${d.owner}` : ' · nobody assigned'}
                  {d.expected_close_date && ` · expected ${formatDate(d.expected_close_date)}`}
                </Meta>
              </Row>
            ))}
          </ul>
        )}
      </Section>
  );
}

export function RetainersSection({ retainers }: { retainers: RelatedRetainer[] }) {
  if (retainers.length === 0) return null;
  return (
        <Section title={`Retainers — ${retainers.length}`}>
          <ul>
            {retainers.map((r) => (
              <Row
                key={r.id}
                href="/retainers"
                title={r.label}
                faded={r.status !== 'active'}
                aside={
                  <>
                    {formatMAD(BigInt(r.monthly_centimes))}
                    <span className="block text-[12px]" style={{ opacity: 0.55 }}>
                      per month
                    </span>
                  </>
                }
              >
                <Meta>
                  {r.status === 'active' ? 'Active' : r.status}
                  {` · billed on day ${r.billing_day}`}
                  {r.end_date && ` · ends ${formatDate(r.end_date)}`}
                </Meta>
              </Row>
            ))}
          </ul>
        </Section>
  );
}

/**
 * Every quote and invoice, for an administrator only. The three totals moved
 * to the summary at the top of the page, where they are seen without opening
 * this tab; what stays here is the list, and the way to add to it.
 */
export function DocumentsSection({
  documents,
  isAdmin,
  companyId,
}: {
  documents: RelatedDocument[];
  isAdmin: boolean;
  companyId: string;
}) {
  const { drafts } = summariseBilling(documents);
  return (
    <>
      {/* ---- the money, for an administrator only ---------------------------- */}
      {isAdmin && (
        <Section
          title={
            documents.length === 0
              ? 'Quotes & invoices'
              : `Quotes & invoices — ${documents.length}`
          }
          action={
            // Opens with this client already chosen, so it is not picked twice.
            <div className="flex flex-wrap gap-2">
              <Link href={`/documents/new?client=${companyId}&type=devis`} className="btn btn-small">
                New quote
              </Link>
              <Link href={`/documents/new?client=${companyId}&type=facture`} className="btn btn-inverse btn-small">
                New invoice
              </Link>
            </div>
          }
        >
          {documents.length === 0 ? (
            <Empty message="Nothing has been quoted or invoiced to this client." />
          ) : (
            <>
              {drafts > 0 && (
                <p className="hint mb-3">
                  {drafts === 1 ? 'One draft is' : `${drafts} drafts are`} not counted above —
                  a draft has no number and is not a claim on anybody. Quotes and credit notes are listed, never counted as owed.
                </p>
              )}

              <ul>
                {documents.map((d) => (
                  <Row
                    key={d.id}
                    href={`/documents/${d.id}`}
                    title={d.number ?? `${DOCUMENT_TYPE_LABELS[d.doc_type] ?? d.doc_type} (draft)`}
                    faded={d.status === 'annule'}
                    aside={
                      <>
                        {formatMAD(BigInt(d.total_incl_vat))}
                        {d.paid_at && (
                          <span className="block text-[12px]" style={{ opacity: 0.55 }}>
                            paid {formatDate(d.paid_at)}
                          </span>
                        )}
                      </>
                    }
                  >
                    <Meta>
                      {DOCUMENT_TYPE_LABELS[d.doc_type] ?? d.doc_type}
                      {` · ${DOCUMENT_STATUS_LABELS[d.status] ?? d.status}`}
                      {d.issue_date && ` · ${formatDate(d.issue_date)}`}
                    </Meta>
                  </Row>
                ))}
              </ul>
            </>
          )}
        </Section>
      )}
    </>
  );
}

export function ConversationsSection({ threads }: { threads: RelatedThread[] }) {
  if (threads.length === 0) return null;
  return (
        <Section title="Conversations">
          <ul>
            {threads.map((t) => (
              <Row
                key={t.id}
                href={`/chat/${t.id}`}
                title={
                  t.kind === 'support'
                    ? 'What the client has written to us'
                    : 'Our channel about this client'
                }
                aside={
                  <>
                    {t.messages} {t.messages === 1 ? 'message' : 'messages'}
                    {t.last_at && (
                      <span className="block text-[12px]" style={{ opacity: 0.55 }}>
                        {formatDate(t.last_at)}
                      </span>
                    )}
                  </>
                }
              >
                <Meta>
                  {/*
                    Which is which, said plainly. The two threads carry the same
                    company name and the difference between them is whether the
                    client reads every word — the one distinction worth spelling
                    out rather than leaving to a title.
                  */}
                  {t.kind === 'support'
                    ? 'They read this. Everything here is written to them.'
                    : 'Internal. The client cannot see this.'}
                </Meta>
              </Row>
            ))}
          </ul>
        </Section>
  );
}
