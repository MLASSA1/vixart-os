import { asc } from 'drizzle-orm';
import { PageHeader } from '@/components/ui';
import { appUser } from '@/db/schema';
import { withUser } from '@/db/session';
import { formatDate } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * The team directory. Readable by everyone — assigning a task (step 4) needs
 * it. Creating and editing accounts is management-only and lands with the
 * screens that need it; today the five accounts come from the seed.
 */
export default async function TeamPage() {
  const members = await withUser(async (tx) =>
    tx
      .select({
        id: appUser.id,
        fullName: appUser.fullName,
        email: appUser.email,
        jobTitle: appUser.jobTitle,
        role: appUser.role,
        isActive: appUser.isActive,
        mustChangePassword: appUser.mustChangePassword,
        createdAt: appUser.createdAt,
      })
      .from(appUser)
      .orderBy(asc(appUser.role), asc(appUser.fullName)),
  );

  return (
    <>
      <PageHeader eyebrow="VIXART" title="Team" />

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b-2 border-void">
              <th className="meta py-2.5 pr-4">Name</th>
              <th className="meta py-2.5 pr-4">Role</th>
              <th className="meta py-2.5 pr-4">Email</th>
              <th className="meta py-2.5 pr-4">Access</th>
              <th className="meta py-2.5 text-right">Since</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.id} className="border-b border-void/10">
                <td className="py-3.5 pr-4">
                  <span className="font-semibold">{member.fullName}</span>
                  {member.mustChangePassword && (
                    <span className="meta ml-3 border border-void px-2 py-0.5">
                      Initial password
                    </span>
                  )}
                </td>
                <td className="py-3.5 pr-4" style={{ opacity: 0.68 }}>
                  {member.jobTitle ?? '—'}
                </td>
                <td className="amount py-3.5 pr-4" style={{ opacity: 0.68 }}>
                  {member.email}
                </td>
                <td className="py-3.5 pr-4">
                  {/* Management is the denser mark. No colour anywhere. */}
                  <span
                    className={`meta inline-block px-2.5 py-1 leading-none ${
                      member.role === 'admin'
                        ? 'bg-void text-pure border-2 border-void'
                        : 'border border-void'
                    }`}
                  >
                    {member.role === 'admin' ? 'Management' : 'Team'}
                  </span>
                </td>
                <td className="amount py-3.5 text-right" style={{ opacity: 0.52 }}>
                  {formatDate(member.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="prose-vixart mt-8 text-[15px]" style={{ opacity: 0.52 }}>
        Management sees Finance, service prices and invoice totals. The team sees
        clients, projects and tasks. The boundary is enforced by PostgreSQL row
        level security, not by hiding menu entries.
      </p>
    </>
  );
}
