import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { withUser } from '@/db/session';
import { listMessages } from '@/lib/chat-queries';
import { markThreadRead } from '@/lib/chat-read';

/**
 * New messages in the open channel, for the five-second poll.
 *
 * `?after=` is the newest timestamp the browser already holds. Without it the
 * whole channel comes back, which is what the first load after a reconnect
 * wants.
 *
 * Polling is also reading: the window is open and in front of somebody, so the
 * read mark moves. It happens here rather than in the page because a page is a
 * render, and the last thing that marked a thread read from a render returned
 * 500 for every user for a fortnight.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return new NextResponse('Not found', { status: 404 });
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse('Not found', { status: 404 });

  const after = new URL(request.url).searchParams.get('after');

  const messages = await withUser(async (tx, user) => {
    // Visibility asked of the thread table, under this person's own policies,
    // BEFORE anything is written. Marking a channel read is an insert against
    // a foreign key: doing it for a channel they cannot see would answer
    // differently for one that exists than for one that does not, and that
    // difference is a way to ask whether a client you are not on has a
    // conversation about it.
    const visible = await tx.execute(sql`SELECT 1 FROM thread WHERE id = ${id}`);
    if (visible.rows.length === 0) return null;

    const rows = await listMessages(tx, id, user.id, after);
    // Polling is reading: the window is open in front of somebody.
    await markThreadRead(tx, user.id, id);
    return rows;
  });

  // Out of reach and never existed give the same answer.
  if (messages === null) return new NextResponse('Not found', { status: 404 });

  return NextResponse.json({ messages });
}
