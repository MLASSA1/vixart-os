import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { withUser } from '@/db/session';
import { listChannels, listDms } from '@/lib/chat-queries';

/**
 * Unread counts for the sidebar — channels and conversations together.
 *
 * Both in one response because they are one question: what has happened that
 * I have not seen. Two routes would mean two round trips to draw one list, and
 * on a single core shared with eight other sites the cheapest request is the
 * one not made.
 *
 * Called on a nudge from `/api/chat/stream`, and on a slow timer behind it in
 * case the stream is not carrying.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await auth();
  if (!session?.user) return new NextResponse('Not found', { status: 404 });

  const { channels, dms } = await withUser(async (tx, user) => ({
    channels: await listChannels(tx, user.id),
    dms: await listDms(tx, user.id),
  }));
  return NextResponse.json({ channels, dms });
}
