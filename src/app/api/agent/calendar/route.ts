import { NextResponse } from 'next/server';
import { calendar } from '@/lib/agent/tools';
import { guardAgentRoute, toolError } from '@/lib/agent/route-helper';

export const dynamic = 'force-dynamic';

/** Fiscal deadlines in a window, soonest first. */
export async function GET(request: Request) {
  const denied = await guardAgentRoute();
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  try {
    return NextResponse.json(await calendar(params.get('from'), params.get('to')));
  } catch (error) {
    return toolError(error);
  }
}
