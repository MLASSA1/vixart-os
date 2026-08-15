-- =============================================================================
-- 0005 — Translate the seeded pipeline text already stored in the database.
--
-- The seed is idempotent: it never rewrites existing rows, so the English
-- wording in seed/vixart.seed.ts only ever reaches a blank database. These
-- descriptions were written by the seed, not typed by the team, so translating
-- them in place is correct.
--
-- Two things this migration has to get right:
--
-- 1. RLS. `client` is under FORCE ROW LEVEL SECURITY, which applies to the
--    owner role running migrations. Without opening the named bootstrap door,
--    every UPDATE below would match zero rows *silently*. Everything therefore
--    runs inside one DO block that sets `app.bootstrap` first.
--
-- 2. Not clobbering real edits. Every statement is guarded by the exact
--    original French string. If anyone has edited a record since, the WHERE
--    clause does not match and their text is left alone. Re-running is
--    harmless for the same reason.
--
-- Client names are left as they are, except "Client Podcast" → "Podcast
-- client": that was seed-authored placeholder wording, not a trading name.
-- =============================================================================

DO $$
DECLARE
  touched integer := 0;
  n integer;
BEGIN
  PERFORM set_config('app.bootstrap', 'on', true);

  UPDATE "client" SET "engagement_summary" =
    'Site refresh + client-management dashboard (enrolment and session tracking).'
   WHERE "name" = 'Bader Training Center'
     AND "engagement_summary" = 'Refonte du site + tableau de bord de gestion des clients (suivi des inscriptions et des sessions).';
  GET DIAGNOSTICS n = ROW_COUNT; touched := touched + n;

  UPDATE "client" SET "engagement_summary" = 'Medical analysis lab — digital presence.'
   WHERE "name" = 'Laboratoire Talborjt'
     AND "engagement_summary" = 'Laboratoire d''analyses médicales — présence digitale.';
  GET DIAGNOSTICS n = ROW_COUNT; touched := touched + n;

  UPDATE "client" SET "engagement_summary" =
    'White-label dropshipping platform — production of the video tutorial tracks.'
   WHERE "name" = 'SILACOD'
     AND "engagement_summary" = 'Plateforme de dropshipping en marque blanche — production des parcours de tutoriels vidéo.';
  GET DIAGNOSTICS n = ROW_COUNT; touched := touched + n;

  UPDATE "client" SET "engagement_summary" = 'Agadir footwear — building the growth system.'
   WHERE "name" = 'Yansin'
     AND "engagement_summary" = 'Chaussure agadirie — construction du système de croissance.';
  GET DIAGNOSTICS n = ROW_COUNT; touched := touched + n;

  UPDATE "client"
     SET "name" = 'Podcast client',
         "engagement_summary" = 'Podcast audience growth.',
         "notes" = 'Trading name to be filled in by Amin — record created from the existing pipeline.'
   WHERE "name" = 'Client Podcast'
     AND "engagement_summary" = 'Croissance d''audience du podcast.';
  GET DIAGNOSTICS n = ROW_COUNT; touched := touched + n;

  UPDATE "client" SET "engagement_summary" = 'Drarga safari park — proposal stage.'
   WHERE "name" = 'Lion Park Agadir'
     AND "engagement_summary" = 'Parc safari de Drarga — proposition en cours.';
  GET DIAGNOSTICS n = ROW_COUNT; touched := touched + n;

  UPDATE "client" SET "engagement_summary" = 'Competitive audit + investment proposal.'
   WHERE "name" = 'Roastery Agadir'
     AND "engagement_summary" = 'Audit concurrentiel + proposition d''investissement.';
  GET DIAGNOSTICS n = ROW_COUNT; touched := touched + n;

  UPDATE "client" SET "engagement_summary" = 'Reference — anchor case study.'
   WHERE "name" = 'Sidi Fares'
     AND "engagement_summary" = 'Référence — étude de cas pilier.';
  GET DIAGNOSTICS n = ROW_COUNT; touched := touched + n;

  UPDATE "client" SET "engagement_summary" = 'Reference — fragrance D2C case study.'
   WHERE "name" = 'ARMURE'
     AND "engagement_summary" = 'Référence — étude de cas parfum D2C.';
  GET DIAGNOSTICS n = ROW_COUNT; touched := touched + n;

  UPDATE "client" SET "notes" = 'Engagement closed. Kept as a commercial reference.'
   WHERE "name" IN ('Sidi Fares', 'ARMURE')
     AND "notes" = 'Mission close. Conservée comme référence commerciale.';
  GET DIAGNOSTICS n = ROW_COUNT; touched := touched + n;

  RAISE NOTICE '[0005] % seeded field(s) translated to English', touched;
END
$$;
