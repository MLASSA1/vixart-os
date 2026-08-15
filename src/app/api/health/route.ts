import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { getOwnerDb } from '@/db';

/**
 * Health probe — used by the container healthcheck and by VPS monitoring.
 * Exposes no business data.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const owner = getOwnerDb();
    const { rows } = await owner.execute<{ migrations: string }>(
      sql`SELECT count(*)::text AS migrations FROM drizzle.__drizzle_migrations`,
    );
    return NextResponse.json({
      status: 'ok',
      database: 'connected',
      migrations: Number(rows[0]?.migrations ?? 0),
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: 'degraded',
        database: 'unreachable',
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
}
