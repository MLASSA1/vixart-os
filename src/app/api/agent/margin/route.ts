import { NextResponse } from 'next/server';
import { margin } from '@/lib/agent/tools';
import { guardAgentRoute, toolError } from '@/lib/agent/route-helper';

export const dynamic = 'force-dynamic';

/** Revenue against cash cost and logged effort, per client. */
export async function GET(request: Request) {
  const denied = await guardAgentRoute();
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  try {
    return NextResponse.json(
      await margin(params.get('from'), params.get('to'), params.get('company')),
    );
  } catch (error) {
    return toolError(error);
  }
}
