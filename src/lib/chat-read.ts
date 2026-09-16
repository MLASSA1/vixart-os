/**
 * "I have read this thread."
 *
 * Deliberately NOT a server action, and deliberately taking the transaction it
 * is to run in.
 *
 * It began life as one — `markThreadReadAction`, called from the thread page
 * and ending in `revalidatePath('/chat')`. Next refuses that: revalidating
 * during a render is unsupported, so every thread page returned 500 and the
 * whole of chat was unreachable. The revalidate was not even buying anything;
 * `/chat` is `force-dynamic` and recomputes its unread counts on every visit.
 *
 * Shaped like this, the mistake cannot come back. A function handed a `Tx` has
 * nowhere to put a cache instruction, and a page that calls it is doing one
 * more write inside the transaction it already opened rather than paying for a
 * second round trip to the database.
 *
 * Marking is idempotent — one timestamp per person per thread, moved forward —
 * so a render that happens twice costs an UPDATE, not a wrong answer.
 */

import { sql } from 'drizzle-orm';
import { threadRead } from '@/db/schema';
import type { Tx } from '@/db/session';

export async function markThreadRead(tx: Tx, userId: string, threadId: string): Promise<void> {
  await tx
    .insert(threadRead)
    .values({ threadId, userId })
    .onConflictDoUpdate({
      target: [threadRead.threadId, threadRead.userId],
      set: { lastReadAt: sql`now()` },
    });
}
