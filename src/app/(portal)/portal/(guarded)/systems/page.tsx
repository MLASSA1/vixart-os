import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireClientSession } from '@/auth';
import { withClient } from '@/db/session';
import { listPortalSystems, type PortalSystem } from '@/lib/client-portal-queries';

export const dynamic = 'force-dynamic';

/** The site's own order and its own one-line descriptions of each family. */
const FAMILIES: Array<{ name: string; blurb: string }> = [
  { name: 'Growth', blurb: 'Finding the right people, earning their trust, and turning attention into revenue.' },
  { name: 'Engineering', blurb: 'Software built around how the business actually runs, not around a demo.' },
  { name: 'Production', blurb: 'Film, photography and short-form, directed and cut in-house.' },
  { name: 'Design', blurb: 'How the brand looks and behaves, decided once and written down.' },
];

export default async function SystemsPage() {
  const session = await requireClientSession();
  if (session.user.mustChangePassword) redirect('/portal/account');

  const systems = await withClient(session.user.id, (tx) => listPortalSystems(tx));

  const byFamily = new Map<string, PortalSystem[]>();
  for (const s of systems) byFamily.set(s.family, [...(byFamily.get(s.family) ?? []), s]);

  return (
    <>
      <p className="vix-meta">What we build</p>
      <h1 className="vix-h1 mt-4">
        {systems.length} systems.
        <br />
        {byFamily.size} families.
        <br />
        One team.
      </h1>
      <p className="vix-lead mt-6">
        The same catalogue as visionxart.com. If any of it is useful to you, say
        so under “Talk to us” and we will put a quote together.
      </p>

      {FAMILIES.filter((f) => byFamily.has(f.name)).map((family, familyIndex) => {
        const items = byFamily.get(family.name)!;
        return (
          <section key={family.name} className="vix-rule mt-16 border-t pt-8">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
              <p className="vix-meta">
                {String(familyIndex + 1).padStart(2, '0')} / {byFamily.size}
              </p>
              <p className="vix-meta">
                {String(items.length).padStart(2, '0')} systems
              </p>
            </div>
            <h2 className="vix-h2 mt-3">{family.name}</h2>
            <p className="vix-body mt-3">{family.blurb}</p>

            <ul className="mt-8">
              {items.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/portal/systems/${s.slug}`}
                    className="vix-rule group flex items-baseline gap-5 border-b py-5 hover:bg-white/[0.03]"
                  >
                    <span className="vix-meta shrink-0 tabular-nums">
                      {String(s.position).padStart(2, '0')}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[17px] font-semibold">{s.name}</span>
                      <span className="vix-quiet mt-1 block">{s.what_it_fixes}</span>
                    </span>
                    <span aria-hidden="true" className="vix-meta shrink-0">→</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}
