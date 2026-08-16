-- =============================================================================
-- 0009 — Service catalog with versioned prices.
--
-- The price is not a column on the service. It lives in `service_price`, one
-- immutable row per version with an `effective_from` date. Raising a price
-- inserts a new row; a quote issued last month keeps the figure it was issued
-- with. This is the same shape as `fiscal_rate`, for the same reason.
-- =============================================================================

CREATE TABLE "service" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "pillar" text NOT NULL,
  "unit" text DEFAULT 'forfait' NOT NULL,
  "description" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "service_name_not_empty" CHECK (length(trim("name")) > 0),
  CONSTRAINT "service_pillar_valid" CHECK ("pillar" IN (
    'brand_architecture','cinematic_production','digital_presence',
    'social_media','growth_marketing','app_automation','codex_ai')),
  CONSTRAINT "service_unit_valid" CHECK ("unit" IN ('forfait','mois','jour'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX "service_name_key" ON "service" USING btree (lower("name"));
--> statement-breakpoint
CREATE INDEX "service_pillar_idx" ON "service" USING btree ("pillar");
--> statement-breakpoint

CREATE TABLE "service_price" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "service_id" uuid NOT NULL,
  "unit_price_centimes" bigint DEFAULT 0 NOT NULL,
  "effective_from" date NOT NULL,
  "note" text,
  "created_by_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- Money is centimes. A negative price is not a discount, it is a mistake.
  CONSTRAINT "service_price_non_negative" CHECK ("unit_price_centimes" >= 0)
);
--> statement-breakpoint

ALTER TABLE "service_price" ADD CONSTRAINT "service_price_service_id_fk"
  FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "service_price" ADD CONSTRAINT "service_price_created_by_id_fk"
  FOREIGN KEY ("created_by_id") REFERENCES "public"."app_user"("id") ON DELETE set null;
--> statement-breakpoint
CREATE UNIQUE INDEX "service_price_version_key"
  ON "service_price" USING btree ("service_id","effective_from");
--> statement-breakpoint
CREATE INDEX "service_price_service_idx" ON "service_price" USING btree ("service_id");
--> statement-breakpoint

CREATE TRIGGER "service_touch_updated_at" BEFORE UPDATE ON "service"
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Price versions are append-only.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.forbid_price_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'A price version is immutable (in force from %). Add a new version with a '
    'later effective_from date instead — editing this one would change what an '
    'already-issued document says.', OLD.effective_from
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "service_price_immutable"
  BEFORE UPDATE OR DELETE ON "service_price"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_price_rewrite();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Row level security
--
-- The team sees WHAT VIXART sells — they have to, to scope work. They do not
-- see what it costs: prices are management only, same boundary as invoice
-- totals and the P&L.
-- -----------------------------------------------------------------------------

ALTER TABLE "service" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "service" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "service_select" ON "service" FOR SELECT USING (app.is_authenticated());
--> statement-breakpoint
CREATE POLICY "service_write" ON "service" FOR ALL
  USING (app.is_admin()) WITH CHECK (app.is_admin());
--> statement-breakpoint
CREATE POLICY "service_bootstrap" ON "service" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());
--> statement-breakpoint

ALTER TABLE "service_price" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "service_price" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Management only, read included. A member querying this table gets nothing.
CREATE POLICY "service_price_admin" ON "service_price" FOR ALL
  USING (app.is_admin()) WITH CHECK (app.is_admin());
--> statement-breakpoint
CREATE POLICY "service_price_bootstrap" ON "service_price" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Seed the catalog: one starting service per pillar, every price at 0.
--
-- Zero is deliberate and load-bearing — pricing is Amin's to set, and an
-- invented figure that reached a client quote would be worse than an empty one.
-- Rename, extend or deactivate these from the Services screen.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  seeded  integer := 0;
  new_id  uuid;
  row     record;
BEGIN
  PERFORM set_config('app.bootstrap', 'on', true);

  IF EXISTS (SELECT 1 FROM service) THEN
    RAISE NOTICE '[0009] service catalog already populated — left untouched';
    RETURN;
  END IF;

  FOR row IN
    SELECT * FROM (VALUES
      ('Brand architecture',   'brand_architecture',   'forfait'),
      ('Cinematic production', 'cinematic_production', 'forfait'),
      ('Digital presence',     'digital_presence',     'forfait'),
      ('Social media management', 'social_media',      'mois'),
      ('Growth marketing',     'growth_marketing',     'mois'),
      ('App & automation',     'app_automation',       'forfait'),
      ('Codex AI',             'codex_ai',             'forfait')
    ) AS t(name, pillar, unit)
  LOOP
    INSERT INTO service (name, pillar, unit) VALUES (row.name, row.pillar, row.unit)
      RETURNING id INTO new_id;
    INSERT INTO service_price (service_id, unit_price_centimes, effective_from, note)
      VALUES (new_id, 0, current_date, 'Starting price — to be set by the founder.');
    seeded := seeded + 1;
  END LOOP;

  RAISE NOTICE '[0009] % service(s) seeded at 0 DH', seeded;
END $$;
