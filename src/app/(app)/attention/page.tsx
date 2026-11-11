import Link from 'next/link';
import { Empty, PageHeader } from '@/components/ui';
import { getAttention, type Severity } from '@/lib/attention';

export const dynamic = 'force-dynamic';

/**
 * Everything waiting on someone, in one place.
 *
 * Derived from current state rather than stored, so an item disappears the
 * moment the thing is done. There is nothing to dismiss and nothing to go
 * stale — see src/lib/attention.ts.
 */

/** Urgency by weight and fill, never by colour. */
const STYLE: Record<Severity, string> = {
  now: 'border-2 border-void',
  soon: 'border border-void/45',
  setup: 'border border-dashed border-void/40',
};

const HEADING: Record<Severity, string> = {
  now: 'Waiting on you now',
  soon: 'Worth a look',
  setup: 'Setup still unfinished',
};

const BLURB: Record<Severity, string> = {
  now: 'Overdue, due today, or blocked on your decision.',
  soon: 'Not urgent, but it will be.',
  setup: 'Things the system cannot decide for you.',
};

export default async function AttentionPage() {
  const items = await getAttention();
  const groups: Severity[] = ['now', 'soon', 'setup'];

  return (
    <>
      <PageHeader
        title="Needs attention"
        intro="Everything waiting on you. An item clears itself once it is done."
      />

      {items.length === 0 ? (
        <Empty message="Nothing is waiting on anyone. Everything is up to date." />
      ) : (
        groups.map((severity) => {
          const group = items.filter((i) => i.severity === severity);
          if (group.length === 0) return null;

          return (
            <section key={severity} className="mt-10 first:mt-0">
              <h2 className="border-b border-void/40 pb-2 text-lg font-semibold">
                {HEADING[severity]}
              </h2>
              <p className="hint mt-1">{BLURB[severity]}</p>

              <ul className="mt-4 space-y-3">
                {group.map((item) => (
                  <li key={item.id}>
                    <Link
                      href={item.href}
                      className={`block px-4 py-3 hover:bg-void hover:text-night ${STYLE[severity]}`}
                    >
                      <p className="font-semibold">{item.title}</p>
                      <p className="prose-vixart mt-0.5 text-[15px] opacity-70">
                        {item.detail}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}

    </>
  );
}
