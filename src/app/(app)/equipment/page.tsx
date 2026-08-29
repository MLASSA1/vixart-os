import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { Empty, PageHeader, Section } from '@/components/ui';
import { withUser } from '@/db/session';
import { EQUIPMENT_CATEGORY_LABELS, EQUIPMENT_STATUS_LABELS } from '@/lib/labels';
import { formatMAD } from '@/lib/money';
import { formatDate } from '@/lib/format';
import { EquipmentForm } from './EquipmentForm';
import {
  addEquipmentAction,
  assignEquipmentAction,
  deleteEquipmentAction,
  setEquipmentStatusAction,
} from './actions';

export const dynamic = 'force-dynamic';

interface Row {
  [k: string]: unknown;
  id: string; name: string; category: string; brand: string | null;
  model: string | null; serial_number: string | null; status: string;
  assigned_to_id: string | null; holder: string | null;
  assigned_at: string | null; purchase_date: string | null;
  purchase_cost_centimes: string; notes: string | null;
}

/** On the shelf is green, out is violet, broken is amber, gone is red. */
const STATUS_STYLE: Record<string, string> = {
  available: 'tone-ok',
  assigned: 'tone-accent',
  repair: 'tone-warn',
  retired: 'tone-quiet opacity-70',
  lost: 'tone-danger',
};

export default async function EquipmentPage() {
  const session = await auth();
  const canManage = session?.user.role !== 'member';
  const canSeeCost = session?.user.role === 'admin';

  const { items, team } = await withUser(async (tx) => {
    const rows = await tx.execute<Row>(sql`
      SELECT e.id, e.name, e.category, e.brand, e.model, e.serial_number, e.status,
             e.assigned_to_id, u.full_name AS holder,
             e.assigned_at::text, e.purchase_date::text,
             e.purchase_cost_centimes::text, e.notes
        FROM equipment e LEFT JOIN app_user u ON u.id = e.assigned_to_id
       ORDER BY CASE e.status WHEN 'assigned' THEN 0 WHEN 'available' THEN 1
                              WHEN 'repair' THEN 2 ELSE 3 END,
                e.category, lower(e.name)
    `);
    const members = await tx.execute<{ id: string; full_name: string }>(
      sql`SELECT id, full_name FROM app_user WHERE is_active ORDER BY full_name`,
    );
    return { items: rows.rows, team: members.rows };
  });

  const out = items.filter((i) => i.status === 'assigned');
  const inOffice = items.filter((i) => i.status === 'available');
  const attention = items.filter((i) => ['repair', 'lost'].includes(i.status));
  const value = items
    .filter((i) => !['retired', 'lost'].includes(i.status))
    .reduce<bigint>((a, i) => a + BigInt(i.purchase_cost_centimes), 0n);

  return (
    <>
      <PageHeader eyebrow="The agency" title="Equipment" />

      <div className="grid grid-cols-2 gap-6 border-b border-void/15 pb-6 md:grid-cols-4">
        <div>
          <p className="label">Checked out</p>
          <p className="kpi mt-1">{out.length}</p>
        </div>
        <div>
          <p className="label">In the office</p>
          <p className="kpi mt-1">{inOffice.length}</p>
        </div>
        <div>
          <p className="label">Needs attention</p>
          <p className="kpi mt-1">{attention.length}</p>
          {attention.length > 0 && <p className="hint mt-1">in repair or lost</p>}
        </div>
        {canSeeCost && (
          <div>
            <p className="label">Registered value</p>
            <p className="kpi mt-1">{formatMAD(value)}</p>
            <p className="hint mt-1">purchase cost, kit still in service</p>
          </div>
        )}
      </div>

      <Section title={`Register — ${items.length}`}>
        {items.length === 0 ? (
          <Empty message="Nothing registered yet — add the cameras, laptops and mics below" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b-2 border-void">
                  <th className="th py-2 pr-4">Item</th>
                  <th className="th py-2 pr-4">Category</th>
                  <th className="th py-2 pr-4">Where</th>
                  {canSeeCost && <th className="th py-2 pr-4 text-right">Cost</th>}
                  {canManage && <th className="th py-2">Move</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b border-void/10 align-top">
                    <td className="py-3 pr-4">
                      <span className="font-semibold">{item.name}</span>
                      <p className="hint">
                        {[item.brand, item.model].filter(Boolean).join(' ')}
                        {item.serial_number ? ` · SN ${item.serial_number}` : ''}
                      </p>
                      {item.notes && <p className="hint">{item.notes}</p>}
                    </td>
                    <td className="hint py-3 pr-4">
                      {EQUIPMENT_CATEGORY_LABELS[item.category] ?? item.category}
                    </td>
                    <td className="py-3 pr-4">
                      <span
                        className={`chip ${
                          STATUS_STYLE[item.status]
                        }`}
                      >
                        {EQUIPMENT_STATUS_LABELS[item.status] ?? item.status}
                      </span>
                      {item.holder && (
                        <p className="hint mt-0.5">
                          {item.holder}
                          {item.assigned_at ? ` · since ${formatDate(item.assigned_at)}` : ''}
                        </p>
                      )}
                    </td>
                    {canSeeCost && (
                      <td className="code py-3 pr-4 text-right whitespace-nowrap">
                        {item.purchase_cost_centimes === '0'
                          ? '—'
                          : formatMAD(BigInt(item.purchase_cost_centimes))}
                      </td>
                    )}
                    {canManage && (
                      <td className="py-3">
                        <form action={assignEquipmentAction} className="flex items-center gap-2">
                          <input type="hidden" name="equipmentId" value={item.id} />
                          <select
                            name="assignedToId"
                            defaultValue={item.assigned_to_id ?? ''}
                            className="input mt-0 w-40 py-1 text-[13px]"
                          >
                            <option value="">— back to office —</option>
                            {team.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.full_name}
                              </option>
                            ))}
                          </select>
                          <button type="submit" className="btn btn-small btn-inverse">
                            Set
                          </button>
                        </form>
                        <details className="mt-1">
                          <summary className="hint cursor-pointer">More</summary>
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            {['repair', 'lost', 'retired'].map((s) => (
                              <form key={s} action={setEquipmentStatusAction}>
                                <input type="hidden" name="equipmentId" value={item.id} />
                                <input type="hidden" name="status" value={s} />
                                <button type="submit" className="btn btn-small btn-inverse">
                                  {EQUIPMENT_STATUS_LABELS[s]}
                                </button>
                              </form>
                            ))}
                            <form action={deleteEquipmentAction}>
                              <input type="hidden" name="equipmentId" value={item.id} />
                              <button type="submit" className="btn btn-small btn-inverse">
                                Delete
                              </button>
                            </form>
                          </div>
                        </details>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {canManage && (
        <Section title="Add equipment">
          <EquipmentForm action={addEquipmentAction} canSeeCost={canSeeCost} />
        </Section>
      )}
    </>
  );
}
