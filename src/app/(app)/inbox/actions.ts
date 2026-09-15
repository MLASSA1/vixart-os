'use server';

import { and, eq, isNull, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { notification } from '@/db/schema';
import { withUser } from '@/db/session';

/**
 * The inbox.
 *
 * No role checks and no ownership checks: `notification_own` and
 * `notification_mark_read` are both `recipient_id = app.current_user_id()`, so
 * a statement here can only ever reach your own rows. Restating it in TypeScript
 * would be a second copy of the rule, free to drift from the one that counts.
 */

export async function markNotificationReadAction(formData: FormData): Promise<void> {
  const id = String(formData.get('notificationId') ?? '');
  if (!id) return;
  await withUser(async (tx) => {
    await tx
      .update(notification)
      .set({ readAt: sql`now()` })
      .where(and(eq(notification.id, id), isNull(notification.readAt)));
  });
  revalidatePath('/inbox');
}

export async function markAllReadAction(): Promise<void> {
  await withUser(async (tx) => {
    await tx.update(notification).set({ readAt: sql`now()` }).where(isNull(notification.readAt));
  });
  revalidatePath('/inbox');
}
