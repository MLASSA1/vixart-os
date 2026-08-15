/**
 * VIXART OS — database seed.
 *
 * IDEMPOTENT. It only runs when the `company` table is empty, and every insert
 * is guarded by ON CONFLICT DO NOTHING. Re-running this script against a
 * database holding real records changes and overwrites nothing.
 *
 * The data below is VIXART's real pipeline, not sample data. No price is
 * invented: the service catalog (step 3) will be seeded at 0 DH — Amin sets
 * pricing himself.
 */

import { hash } from 'bcryptjs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client as PgClient } from 'pg';
import { appUser, company, fiscalRate } from '../src/db/schema';
import { SEED_RATES } from '../src/lib/fiscal';

// ---------------------------------------------------------------------------
// The team — the only five accounts in the system. No public sign-up.
//
// Assumption: internal @vixart.ma addresses. If the mail domain differs, change
// it here BEFORE the first start, or update the address from the Team screen
// once signed in.
// ---------------------------------------------------------------------------

const TEAM = [
  {
    email: 'amin@vixart.ma',
    fullName: 'Amin',
    jobTitle: 'Founder / CEO',
    role: 'admin' as const,
  },
  {
    email: 'aymen@vixart.ma',
    fullName: 'Aymen',
    jobTitle: 'Cinematic Director',
    role: 'member' as const,
  },
  {
    email: 'azzedine@vixart.ma',
    fullName: 'Azzedine',
    jobTitle: 'Editor & Motion Design',
    role: 'member' as const,
  },
  {
    email: 'adam@vixart.ma',
    fullName: 'Adam',
    jobTitle: 'Community & Social Media Manager',
    role: 'member' as const,
  },
  {
    email: 'mohamed.amine@vixart.ma',
    fullName: 'Mohamed Amine',
    jobTitle: 'Creative Director & Designer',
    // Moderates the work: assigns tasks, tracks progress, signs off completion.
    role: 'moderator' as const,
  },
];

// ---------------------------------------------------------------------------
// The real pipeline. ICE and tax IDs are left empty on purpose: they get typed
// in record by record from the clients' own documents. An invented ICE on an
// invoice makes the invoice false.
// ---------------------------------------------------------------------------

const PIPELINE = [
  {
    name: 'Bader Training Center',
    status: 'client' as const,
    city: 'Agadir',
    engagementSummary:
      'Site refresh + client-management dashboard (enrolment and session tracking).',
    notes: null,
  },
  {
    name: 'Laboratoire Talborjt',
    status: 'client' as const,
    city: 'Agadir',
    engagementSummary: 'Medical analysis lab — digital presence.',
    notes: null,
  },
  {
    name: 'SILACOD',
    status: 'client' as const,
    city: 'Agadir',
    website: 'https://silacod.com',
    engagementSummary:
      'White-label dropshipping platform — production of the video tutorial tracks.',
    notes: null,
  },
  {
    name: 'Yansin',
    status: 'client' as const,
    city: 'Agadir',
    engagementSummary: 'Agadir footwear — building the growth system.',
    notes: null,
  },
  {
    name: 'Podcast client',
    status: 'client' as const,
    engagementSummary: 'Podcast audience growth.',
    notes: 'Trading name to be filled in by Amin — record created from the existing pipeline.',
  },
  {
    name: 'Lion Park Agadir',
    status: 'prospect' as const,
    city: 'Drarga',
    engagementSummary: 'Drarga safari park — proposal stage.',
    notes: null,
  },
  {
    name: 'Roastery Agadir',
    status: 'prospect' as const,
    city: 'Agadir',
    engagementSummary: 'Competitive audit + investment proposal.',
    notes: null,
  },
  {
    name: 'Sidi Fares',
    status: 'dormant' as const,
    engagementSummary: 'Reference — anchor case study.',
    notes: 'Engagement closed. Kept as a commercial reference.',
  },
  {
    name: 'ARMURE',
    status: 'dormant' as const,
    engagementSummary: 'Reference — fragrance D2C case study.',
    notes: 'Engagement closed. Kept as a commercial reference.',
  },
];

// ---------------------------------------------------------------------------

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL missing: see .env.example');

  const password = process.env.SEED_DEFAULT_PASSWORD;
  if (!password || password.length < 10) {
    throw new Error(
      'SEED_DEFAULT_PASSWORD missing or too short (10 characters minimum). See .env.example.',
    );
  }

  const pg = new PgClient({ connectionString: url });
  await pg.connect();

  try {
    // RLS is FORCEd, including for the table owner. This explicit door is
    // opened only by the start-up scripts.
    await pg.query("SET app.bootstrap = 'on'");

    const db = drizzle(pg, { casing: 'snake_case' });

    // --- Idempotence guard: the seed only runs against a blank database ---
    const { rows } = await pg.query<{ n: string }>('SELECT count(*)::text AS n FROM company');
    const existing = Number(rows[0]?.n ?? 0);

    if (existing > 0) {
      console.log(
        `[seed] ${existing} company record(s) already present — seed skipped, no data touched.`,
      );
      return;
    }

    console.log('[seed] blank database — seeding');

    // --- Versioned tax parameters ---
    for (const rate of SEED_RATES) {
      await db
        .insert(fiscalRate)
        .values({
          key: rate.key,
          rateBp: rate.bp,
          effectiveFrom: rate.effectiveFrom,
          note: rate.note,
        })
        .onConflictDoNothing();
    }
    console.log(`[seed] ${SEED_RATES.length} tax parameter(s)`);

    // --- Team ---
    // bcrypt cost 12: ~250 ms per hash, painful to brute-force offline,
    // unnoticeable here.
    const sharedHash = await hash(password, 12);
    for (const member of TEAM) {
      await db
        .insert(appUser)
        .values({ ...member, passwordHash: sharedHash })
        .onConflictDoNothing();
    }
    console.log(`[seed] ${TEAM.length} team accounts (shared initial password)`);

    // --- Pipeline ---
    for (const record of PIPELINE) {
      await db.insert(company).values(record).onConflictDoNothing();
    }

    const byStatus = PIPELINE.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      `[seed] ${PIPELINE.length} company records — ` +
        Object.entries(byStatus)
          .map(([s, n]) => `${n} ${s}`)
          .join(', '),
    );

    console.log('[seed] done');
  } finally {
    await pg.end();
  }
}

main().catch((error) => {
  console.error('[seed] FAILED:', error);
  process.exit(1);
});
