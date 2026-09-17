import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { withUser } from '@/db/session';
import { listChannels } from '@/lib/chat-queries';

/**
 * Unread counts, for the thirty-second poll.
 *
 * No websockets: one core serves this and eight other sites. Two polls, both
 * stopped while the tab is hidden, cost the database a pair of indexed counts
 * per person actually looking at chat — and nothing at all from the eight tabs
 * somebody left open on Friday.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await auth();
  if (!session?.user) return new NextResponse('Not found', { status: 404 });

  const channels = await withUser(async (tx, user) => listChannels(tx, user.id));
  return NextResponse.json({ channels });
}
