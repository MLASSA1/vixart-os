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
      <PageHeader eyebrow="VIXART OS" title="Needs attention" />

      {items.length === 0 ? (
        <Empty message="Nothing is waiting on anyone. Everything is up to date." />
      ) : (
        groups.map((severity) => {
          const group = items.filter((i) => i.severity === severity);
          if (group.length === 0) return null;

          return (
            <section key={severity} className="mt-10 first:mt-0">
              <h2 className="border-b border-void pb-2 text-lg font-semibold">
                {HEADING[severity]}
              </h2>
              <p className="hint mt-1">{BLURB[severity]}</p>

              <ul className="mt-4 space-y-3">
                {group.map((item) => (
                  <li key={item.id}>
                    <Link
                      href={item.href}
                      className={`block px-4 py-3 hover:bg-void hover:text-pure ${STYLE[severity]}`}
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

      <p className="prose-vixart mt-12 border-t border-void/10 pt-6 text-[15px]" style={{ opacity: 0.55 }}>
        This list is worked out fresh every time you open it, not stored. An item
        disappears when the thing is actually done — there is nothing to dismiss,
        and nothing here can be out of date.
      </p>
    </>
  );
}
