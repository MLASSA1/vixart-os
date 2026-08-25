import { NextResponse } from 'next/server';
import { receivables } from '@/lib/agent/tools';
import { guardAgentRoute, toolError } from '@/lib/agent/route-helper';

export const dynamic = 'force-dynamic';

/** Issued unpaid invoices, aged into buckets. */
export async function GET() {
  const denied = await guardAgentRoute();
  if (denied) return denied;

  try {
    return NextResponse.json(await receivables());
  } catch (error) {
    return toolError(error);
  }
}
