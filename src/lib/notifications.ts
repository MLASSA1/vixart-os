import { sql } from 'drizzle-orm';
import { withUser } from '@/db/session';

/**
 * How many notifications are waiting for whoever is asking.
 *
 * No `WHERE recipient_id = …` here on purpose: `notification_own` is exactly
 * that clause, so the count can only ever be of your own rows. Adding it again
 * would be a second copy of the rule, free to drift from the one enforced.
 */
export async function unreadCount(): Promise<number> {
  try {
    return await withUser(async (tx) => {
      const r = await tx.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM notification WHERE read_at IS NULL`,
      );
      return Number(r.rows[0]?.n ?? 0);
    });
  } catch {
    // The badge is a convenience. A shell that refuses to render because a
    // count failed would be a worse outcome than a missing number.
    return 0;
  }
}
