import { NextResponse } from 'next/server';
import { draftInvoice } from '@/lib/agent/tools';
import { guardAgentRoute, toolError } from '@/lib/agent/route-helper';

export const dynamic = 'force-dynamic';

/**
 * Writes a DRAFT invoice. POST, because it writes.
 *
 * It cannot issue a number — the agent's INSERT policy requires
 * status = 'brouillon' with a null number, and app.issue_document() refuses an
 * agent session. Amin issues it himself.
 */
export async function POST(request: Request) {
  const denied = await guardAgentRoute();
  if (denied) return denied;

  try {
    const body = (await request.json()) as {
      dealId?: string; companyId?: string; subject?: string;
    };
    return NextResponse.json(
      await draftInvoice(body.dealId ?? null, body.companyId ?? null, body.subject ?? null),
    );
  } catch (error) {
    return toolError(error);
  }
}
