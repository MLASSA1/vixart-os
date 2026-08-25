import { NextResponse } from 'next/server';
import { treasury } from '@/lib/agent/tools';
import { guardAgentRoute, toolError } from '@/lib/agent/route-helper';

export const dynamic = 'force-dynamic';

/** Money in, money out, net — over a period. Defaults to this month. */
export async function GET(request: Request) {
  const denied = await guardAgentRoute();
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  try {
    return NextResponse.json(await treasury(params.get('from'), params.get('to')));
  } catch (error) {
    return toolError(error);
  }
}
