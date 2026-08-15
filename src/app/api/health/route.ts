import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { getOwnerDb } from '@/db';

/**
 * Sonde de santé — utilisée par le healthcheck du conteneur et par la
 * supervision du VPS. N'expose aucune donnée métier.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const owner = getOwnerDb();
    const { rows } = await owner.execute<{ migrations: string }>(
      sql`SELECT count(*)::text AS migrations FROM drizzle.__drizzle_migrations`,
    );
    return NextResponse.json({
      statut: 'ok',
      base: 'connectée',
      migrations: Number(rows[0]?.migrations ?? 0),
    });
  } catch (erreur) {
    return NextResponse.json(
      {
        statut: 'dégradé',
        base: 'injoignable',
        detail: erreur instanceof Error ? erreur.message : String(erreur),
      },
      { status: 503 },
    );
  }
}
