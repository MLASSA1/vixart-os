import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { Empty, PageHeader, Section } from '@/components/ui';
import { withUser } from '@/db/session';
import { PILLARS, PILLAR_LABELS, SERVICE_UNIT_LABELS } from '@/lib/labels';
import { formatMAD } from '@/lib/money';
import { formatDate } from '@/lib/format';
import {
  createServiceAction,
  setPriceAction,
  toggleServiceAction,
  updateServiceAction,
} from './actions';
import { PriceForm, ServiceForm } from './ServiceForms';

export const dynamic = 'force-dynamic';

interface ServiceRow {
  [k: string]: unknown;
  id: string;
  name: string;
  pillar: string;
  unit: string;
  description: string | null;
  is_active: boolean;
  current_price: string | null;
  price_from: string | null;
  version_count: string;
}

interface PriceRow {
  [k: string]: unknown;
  service_id: string;
  unit_price_centimes: string;
  effective_from: string;
  note: string | null;
  author: string | null;
  in_force: boolean;
}

export default async function ServicesPage() {
  const session = await auth();
  const isAdmin = session!.user.role === 'admin';
  const today = new Date().toISOString().slice(0, 10);

  const { services, history } = await withUser(async (tx) => {
    // The current price is the newest version already in force today.
    const rows = await tx.execute<ServiceRow>(sql`
      SELECT s.id, s.name, s.pillar, s.unit, s.description, s.is_active,
             cur.unit_price_centimes::text        AS current_price,
             cur.effective_from::text             AS price_from,
             (SELECT count(*)::text FROM service_price p WHERE p.service_id = s.id) AS version_count
        FROM service s
        LEFT JOIN LATERAL (
          SELECT p.unit_price_centimes, p.effective_from
            FROM service_price p
           WHERE p.service_id = s.id AND p.effective_from <= current_date
           ORDER BY p.effective_from DESC
           LIMIT 1
        ) cur ON true
       ORDER BY s.is_active DESC, s.pillar, lower(s.name)
    `);

    // Members get nothing from service_price — the policy is admin-only — so
    // the query is not even attempted for them.
    let prices: PriceRow[] = [];
    if (isAdmin) {
      const p = await tx.execute<PriceRow>(sql`
        SELECT p.service_id, p.unit_price_centimes::text, p.effective_from::text AS effective_from,
               p.note, u.full_name AS author,
               (p.effective_from <= current_date) AS in_force
          FROM service_price p
          LEFT JOIN app_user u ON u.id = p.created_by_id
         ORDER BY p.service_id, p.effective_from DESC
      `);
      prices = p.rows;
    }
    return { services: rows.rows, history: prices };
  });

  const active = services.filter((s) => s.is_active);
  const priced = active.filter((s) => s.current_price && s.current_price !== '0');

  return (
    <>
      <PageHeader eyebrow="Catalog" title="Services" />

      <div className="grid grid-cols-2 gap-6 border-b border-void/15 pb-6 md:grid-cols-4">
        <div>
          <p className="label">Active services</p>
          <p className="kpi mt-1">{active.length}</p>
        </div>
        <div>
          <p className="label">Pillars covered</p>
          <p className="kpi mt-1">{new Set(active.map((s) => s.pillar)).size} / 7</p>
        </div>
        {isAdmin && (
          <>
            <div>
              <p className="label">Priced</p>
              <p className="kpi mt-1">{priced.length}</p>
            </div>
            <div>
              <p className="label">Still at 0 DH</p>
              <p className="kpi mt-1">{active.length - priced.length}</p>
              <p className="hint mt-1">Waiting on your rate card.</p>
            </div>
          </>
        )}
      </div>

      {!isAdmin && (
        <p className="hint mt-6">
          You can see what VIXART sells. Prices are management only — the
          database refuses the query, it is not just hidden here.
        </p>
      )}

      {PILLARS.map((pillar) => {
        const inPillar = services.filter((s) => s.pillar === pillar.value);
        if (inPillar.length === 0) return null;

        return (
          <Section key={pillar.value} title={pillar.label}>
            <ul className="border-t border-void/10">
              {inPillar.map((svc) => {
                const versions = history.filter((h) => h.service_id === svc.id);
                return (
                  <li key={svc.id} className="border-b border-void/10 py-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
                      <div className="min-w-0">
                        <span
                          className={`font-semibold ${svc.is_active ? '' : 'opacity-50 line-through'}`}
                        >
                          {svc.name}
                        </span>
                        <span className="hint ml-3">
                          {SERVICE_UNIT_LABELS[svc.unit] ?? svc.unit}
                        </span>
                        {svc.description && (
                          <p className="hint mt-0.5 max-w-xl">{svc.description}</p>
                        )}
                      </div>

                      {isAdmin && (
                        <div className="text-right">
                          <p className="code text-lg font-semibold">
                            {formatMAD(BigInt(svc.current_price ?? '0'))}
                          </p>
                          <p className="hint">
                            {svc.price_from ? `since ${formatDate(svc.price_from)}` : 'no price set'}
                            {Number(svc.version_count) > 1 &&
                              ` · ${svc.version_count} versions`}
                          </p>
                        </div>
                      )}
                    </div>

                    {isAdmin && (
                      <details className="mt-2">
                        <summary className="hint cursor-pointer">
                          Change price, edit, or {svc.is_active ? 'deactivate' : 'reactivate'}
                        </summary>
                        <div className="border-l border-void/20 pt-2 pl-4">
                          <PriceForm
                            action={setPriceAction.bind(null, svc.id)}
                            today={today}
                          />

                          {versions.length > 0 && (
                            <div className="mt-4">
                              <p className="label">Price history</p>
                              <ul className="mt-1">
                                {versions.map((v) => (
                                  <li
                                    key={`${v.service_id}-${v.effective_from}`}
                                    className="flex flex-wrap items-baseline gap-x-4 border-b border-void/10 py-1.5"
                                  >
                                    <span className="code">
                                      {formatMAD(BigInt(v.unit_price_centimes))}
                                    </span>
                                    <span className="hint">
                                      from {formatDate(v.effective_from)}
                                      {v.in_force ? ' · in force' : ' · scheduled'}
                                    </span>
                                    {v.note && <span className="hint">— {v.note}</span>}
                                    {v.author && <span className="hint">· {v.author}</span>}
                                  </li>
                                ))}
                              </ul>
                              <p className="hint mt-2">
                                Versions are permanent. The database refuses to edit or
                                delete one, so a quote issued last month keeps its figure.
                              </p>
                            </div>
                          )}

                          <div className="mt-5">
                            <p className="label mb-2">Edit the service</p>
                            <ServiceForm
                              action={updateServiceAction.bind(null, svc.id)}
                              record={{
                                name: svc.name,
                                pillar: svc.pillar,
                                unit: svc.unit,
                                description: svc.description,
                              }}
                              submitLabel="Save service"
                            />
                          </div>

                          <form action={toggleServiceAction} className="mt-3">
                            <input type="hidden" name="serviceId" value={svc.id} />
                            <input
                              type="hidden"
                              name="active"
                              value={svc.is_active ? 'false' : 'true'}
                            />
                            <button type="submit" className="btn btn-inverse btn-small">
                              {svc.is_active
                                ? 'Deactivate — hide from new quotes'
                                : 'Reactivate'}
                            </button>
                          </form>
                        </div>
                      </details>
                    )}
                  </li>
                );
              })}
            </ul>
          </Section>
        );
      })}

      {services.length === 0 && (
        <div className="mt-8">
          <Empty message="No service in the catalog" />
        </div>
      )}

      {isAdmin && (
        <Section title="Add a service">
          <ServiceForm
            action={createServiceAction}
            submitLabel="Add service"
            withPrice
          />
        </Section>
      )}
    </>
  );
}
