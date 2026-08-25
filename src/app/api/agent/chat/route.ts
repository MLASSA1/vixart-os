import { NextResponse } from 'next/server';
import type Anthropic from '@anthropic-ai/sdk';
import { ask, isConfigured } from '@/lib/agent/comptable';
import { guardAgentRoute } from '@/lib/agent/route-helper';

export const dynamic = 'force-dynamic';
/** A tool loop can take a while; well inside the platform limit. */
export const maxDuration = 120;

interface Incoming {
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export async function POST(request: Request) {
  const denied = await guardAgentRoute();
  if (denied) return denied;

  if (!isConfigured()) {
    return NextResponse.json(
      {
        error:
          'Le Comptable is not configured. Add ANTHROPIC_API_KEY to .env and restart. ' +
          'Everything else on this screen works without it.',
      },
      { status: 503 },
    );
  }

  let body: Incoming;
  try {
    body = (await request.json()) as Incoming;
  } catch {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 });
  }

  const incoming = body.messages ?? [];
  if (incoming.length === 0) {
    return NextResponse.json({ error: 'Nothing to answer.' }, { status: 400 });
  }

  // Only role and text cross the boundary. Anything else the client sent —
  // fabricated tool results, forged assistant turns with figures in them — is
  // dropped rather than replayed to the model as if it came from the database.
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
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
