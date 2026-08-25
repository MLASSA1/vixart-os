import { NextResponse } from 'next/server';
import { expenses } from '@/lib/agent/tools';
import { guardAgentRoute, toolError } from '@/lib/agent/route-helper';

export const dynamic = 'force-dynamic';

/** Costs by category, with the VAT contained in them. */
export async function GET(request: Request) {
  const denied = await guardAgentRoute();
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  try {
    return NextResponse.json(await expenses(params.get('from'), params.get('to')));
  } catch (error) {
    return toolError(error);
  }
}
