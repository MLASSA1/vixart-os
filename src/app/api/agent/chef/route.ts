import { NextResponse } from 'next/server';
import type Anthropic from '@anthropic-ai/sdk';
import { auth } from '@/auth';
import { ask, isConfigured } from '@/lib/agent/chef';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Le Chef is for whoever runs the work: management and the moderator.
 * A member has their own tasks on /my-work and no business reassigning others.
 */
async function guard(): Promise<NextResponse | null> {
  const session = await auth();
  const role = session?.user.role;
  if (role !== 'admin' && role !== 'moderator') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return null;
}

export async function POST(request: Request) {
  const denied = await guard();
  if (denied) return denied;

  if (!isConfigured()) {
    return NextResponse.json(
      {
        error:
          'Le Chef is not configured. Add ANTHROPIC_API_KEY to .env and restart. ' +
          'Everything else on this screen works without it.',
      },
      { status: 503 },
    );
  }

  let body: { messages?: Array<{ role: 'user' | 'assistant'; content: string }> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 });
  }

  const incoming = body.messages ?? [];
  if (incoming.length === 0) {
    return NextResponse.json({ error: 'Nothing to answer.' }, { status: 400 });
  }

  // Only role and text cross the boundary — never a client-supplied tool result.
  const history: Anthropic.MessageParam[] = incoming
    .slice(-20)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));

  if (history[0]?.role !== 'user') {
    return NextResponse.json(
      { error: 'A conversation has to start with a question.' },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await ask(history));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
