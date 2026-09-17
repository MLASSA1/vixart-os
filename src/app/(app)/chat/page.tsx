import { sql } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { withUser } from '@/db/session';
import { Empty } from '@/components/ui';

/**
 * Chat opens where everyone can talk.
 *
 * There is no "pick a channel" screen because there is nothing to decide: the
 * agency channel exists, created by migration 0046, and it is the one place
 * everybody can read. `redirect` is legal from a render — it is `revalidatePath`
 * that is not, which is what used to return 500 here.
 */
export const dynamic = 'force-dynamic';

export default async function ChatIndex() {
  const general = await withUser(async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      SELECT id FROM thread WHERE kind = 'general' AND is_default LIMIT 1
    `);
    return rows.rows[0]?.id ?? null;
  });

  if (general) redirect(`/chat/${general}`);

  // Only reachable on a database where the migration found no account to
  // attribute General to and the seed has not run since.
  return (
    <div className="px-6 py-10">
      <Empty message="No channels yet." />
    </div>
  );
}
