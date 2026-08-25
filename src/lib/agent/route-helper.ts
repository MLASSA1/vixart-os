import 'server-only';

import { NextResponse } from 'next/server';
import { auth } from '@/auth';

/**
 * Every agent tool route is admin-only, at the HTTP edge as well as in the
 * database. The agent role can read the ledger; that does not mean a member
 * should be able to curl the ledger through it.
 */
export async function guardAgentRoute(): Promise<NextResponse | null> {
  const session = await auth();
  if (session?.user.role !== 'admin') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return null;
}

/** Turns a thrown tool error into a readable 400 rather than a 500 stack. */
export function toolError(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json({ error: message }, { status: 400 });
}
