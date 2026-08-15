-- =============================================================================
-- 0001 — Règles de fondation : contexte de session, RLS, horodatage, contrôles.
--
-- Tout ce qui se trouve ici est écrit à la main : ce sont les garde-fous qui
-- doivent survivre à une erreur de code applicatif. PostgreSQL est la dernière
-- ligne de défense, pas l'interface.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Contexte de session applicatif
--
-- L'application pose `app.user_id` et `app.user_role` au début de chaque
-- transaction (SET LOCAL). Les politiques RLS lisent ces réglages. `SET LOCAL`
-- garantit que le contexte meurt avec la transaction, même si la connexion est
-- recyclée par le pool.
-- -----------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.current_user_role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.user_role', true), ''), 'anonymous');
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.is_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.current_user_role() = 'admin';
$$;
--> statement-breakpoint

-- Toute session authentifiée : admin ou member. `anonymous` ne voit rien.
CREATE OR REPLACE FUNCTION app.is_authenticated() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.current_user_role() IN ('admin', 'member');
$$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA app TO PUBLIC;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 2. Horodatage automatique — `updated_at` ne dépend pas du code applicatif.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER app_user_touch_updated_at
  BEFORE UPDATE ON "app_user"
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
--> statement-breakpoint

CREATE TRIGGER client_touch_updated_at
  BEFORE UPDATE ON "client"
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 3. Contrôles d'intégrité métier
-- -----------------------------------------------------------------------------

-- Un taux est un entier de points de base, positif, plafonné à 100 %.
ALTER TABLE "fiscal_rate"
  ADD CONSTRAINT fiscal_rate_bp_range CHECK ("rate_bp" >= 0 AND "rate_bp" <= 10000);
--> statement-breakpoint

-- Un paramètre fiscal ne s'écrase pas : on ajoute une version datée.
-- Toute tentative de modification d'une version existante est refusée.
CREATE OR REPLACE FUNCTION app.forbid_fiscal_rate_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'Un paramètre fiscal est versionné et immuable (clé « % », en vigueur au %). '
    'Insérez une nouvelle version avec une date effective_from postérieure.',
    OLD.key, OLD.effective_from
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER fiscal_rate_immutable
  BEFORE UPDATE OR DELETE ON "fiscal_rate"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_fiscal_rate_update();
--> statement-breakpoint

-- Un e-mail d'équipe doit ressembler à un e-mail.
ALTER TABLE "app_user"
  ADD CONSTRAINT app_user_email_shape CHECK ("email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');
--> statement-breakpoint

-- L'ICE marocain fait 15 chiffres. Colonne facultative (un prospect peut ne pas
-- l'avoir communiqué), mais si elle est remplie, elle doit être valide : un ICE
-- faux sur une facture est un problème fiscal.
ALTER TABLE "client"
  ADD CONSTRAINT client_ice_shape CHECK ("ice" IS NULL OR "ice" ~ '^[0-9]{15}$');
--> statement-breakpoint

-- L'identifiant fiscal marocain est numérique, 7 à 8 chiffres.
ALTER TABLE "client"
  ADD CONSTRAINT client_if_shape CHECK ("identifiant_fiscal" IS NULL OR "identifiant_fiscal" ~ '^[0-9]{6,9}$');
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 4. Row Level Security
--
-- FORCE ROW LEVEL SECURITY : les politiques s'appliquent même au propriétaire
-- des tables. Sans ce FORCE, une erreur de configuration faisant tourner
-- l'application sous le rôle propriétaire désactiverait silencieusement toute
-- la sécurité. On ferme cette porte maintenant.
--
-- Phase 0 : les trois tables de fondation. La frontière Finance (admin seul)
-- arrive avec les tables correspondantes, en phase 2 et 4.
-- -----------------------------------------------------------------------------

ALTER TABLE "app_user" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app_user" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Toute l'équipe voit l'annuaire de l'équipe (nécessaire pour assigner une tâche).
CREATE POLICY app_user_select ON "app_user"
  FOR SELECT USING (app.is_authenticated());
--> statement-breakpoint

-- Seul l'admin crée ou supprime un compte. Un membre ne modifie que sa propre
-- fiche, et ne peut pas s'auto-promouvoir : le rôle est verrouillé côté RLS.
CREATE POLICY app_user_insert_admin ON "app_user"
  FOR INSERT WITH CHECK (app.is_admin());
--> statement-breakpoint

CREATE POLICY app_user_update ON "app_user"
  FOR UPDATE
  USING (app.is_admin() OR "id" = app.current_user_id())
  WITH CHECK (
    app.is_admin()
    OR ("id" = app.current_user_id() AND "role" = 'member')
  );
--> statement-breakpoint

CREATE POLICY app_user_delete_admin ON "app_user"
  FOR DELETE USING (app.is_admin());
--> statement-breakpoint

ALTER TABLE "client" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "client" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- L'équipe entière travaille sur le client actif : tout le monde le voit.
-- Ce qui est cloisonné, c'est l'argent (phase 2 et 4), pas la relation client.
CREATE POLICY client_select ON "client"
  FOR SELECT USING (app.is_authenticated());
--> statement-breakpoint
CREATE POLICY client_insert ON "client"
  FOR INSERT WITH CHECK (app.is_authenticated());
--> statement-breakpoint
CREATE POLICY client_update ON "client"
  FOR UPDATE USING (app.is_authenticated()) WITH CHECK (app.is_authenticated());
--> statement-breakpoint

-- Supprimer une fiche client efface son historique : réservé à l'admin.
CREATE POLICY client_delete_admin ON "client"
  FOR DELETE USING (app.is_admin());
--> statement-breakpoint

ALTER TABLE "fiscal_rate" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fiscal_rate" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Les taux sont lisibles par l'application (calcul des documents) mais seul
-- l'admin peut publier une nouvelle version.
CREATE POLICY fiscal_rate_select ON "fiscal_rate"
  FOR SELECT USING (app.is_authenticated());
--> statement-breakpoint
CREATE POLICY fiscal_rate_insert_admin ON "fiscal_rate"
  FOR INSERT WITH CHECK (app.is_admin());
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 5. Exemption pour les tâches de démarrage
--
-- Migrations et seed tournent hors contexte de session (aucun app.user_id).
-- Ils s'exécutent sous le rôle propriétaire, qui est soumis au FORCE RLS
-- ci-dessus. On leur ouvre une porte explicite et nommée plutôt que de
-- désactiver le RLS : `app.bootstrap = on` n'est posé que par scripts/migrate.ts
-- et seed/vixart.seed.ts, jamais par une route HTTP.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.is_bootstrap() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.bootstrap', true), 'off') = 'on';
$$;
--> statement-breakpoint

CREATE POLICY app_user_bootstrap ON "app_user" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());
--> statement-breakpoint
CREATE POLICY client_bootstrap ON "client" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());
--> statement-breakpoint
CREATE POLICY fiscal_rate_bootstrap ON "fiscal_rate" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());
