import { redirect } from 'next/navigation';
import { requireClientSession } from '@/auth';
import { withClient } from '@/db/session';
import { listPortalServices, type PortalService } from '@/lib/client-portal-queries';

export const dynamic = 'force-dynamic';

export default async function ServicesPage() {
  const session = await requireClientSession();
  if (session.user.mustChangePassword) redirect('/portal/account');

  const services = await withClient(session.user.id, (tx) => listPortalServices(tx));

  const byPillar = new Map<string, PortalService[]>();
  for (const s of services) {
    byPillar.set(s.pillar, [...(byPillar.get(s.pillar) ?? []), s]);
  }

  return (
    <>
      <h1 className="display text-3xl font-bold tracking-tight">What we do</h1>
      <p className="prose-vixart mt-3" style={{ opacity: 0.7 }}>
        If any of this is useful to you, say so under “Talk to us” and we will
        put a quote together.
      </p>

      {services.length === 0 ? (
        <p className="hint mt-8">Nothing listed yet.</p>
      ) : (
        [...byPillar.entries()].map(([pillar, items]) => (
          <section key={pillar} className="mt-8">
            <h2 className="label" style={{ opacity: 0.6 }}>{pillar}</h2>
            <ul className="mt-3 space-y-3">
              {items.map((s) => (
                <li key={s.id} className="card px-5 py-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                    <p className="font-semibold">{s.name}</p>
                    <span className="hint">per {s.unit}</span>
                  </div>
                  {s.description && <p className="prose-vixart mt-1.5">{s.description}</p>}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </>
  );
}
