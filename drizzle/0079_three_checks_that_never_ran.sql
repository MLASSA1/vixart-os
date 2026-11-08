/*
 * Three integrity checks that 0003 declares and production has never had.
 *
 * HOW THEY WENT MISSING. 0003 was applied, and then its file grew three more
 * constraints. An applied migration never runs again, so the file says one
 * thing and every database that ran the earlier draft says another. The gap was
 * invisible because nothing reads a constraint by name — it only shows up when
 * data that should have been refused gets in.
 *
 * Found by comparing every `ADD CONSTRAINT` across the migrations against
 * `pg_constraint` in production: 32 declared, 187 live, and exactly these three
 * declared-and-never-dropped names absent. (`client_ice_shape` and
 * `client_if_shape` also looked absent and are not — 0006 RENAMEs them to
 * `company_ice_shape` and `company_if_shape`.)
 *
 * SAFE TO ADD TODAY. Checked first: no contact has a blank name, no interaction
 * has a blank title, and no interaction is dated in the future. So each ALTER
 * validates the existing rows and passes rather than failing mid-deploy.
 *
 * GUARDED, because a database built from zero gets all three from 0003 itself
 * and `ADD CONSTRAINT` has no IF NOT EXISTS. Without the guard this migration
 * would fail on every fresh instance, which is the opposite of the problem it
 * fixes.
 *
 * The definitions are copied from 0003 exactly. Writing a tighter or looser
 * rule here would be inventing policy; the job is to make the database say what
 * the migration has always said.
 */

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contact_name_not_empty') THEN
    ALTER TABLE "contact"
      ADD CONSTRAINT contact_name_not_empty CHECK (length(trim("full_name")) > 0);
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'interaction_title_not_empty') THEN
    ALTER TABLE "interaction"
      ADD CONSTRAINT interaction_title_not_empty CHECK (length(trim("title")) > 0);
  END IF;
END $$;
--> statement-breakpoint

/*
 * The future-date check, with the caveat written down rather than discovered.
 *
 * `now()` in a CHECK is not immutable, which PostgreSQL permits and style
 * guides discourage. It is sound here and worth knowing why: a CHECK is
 * evaluated on write and never re-evaluated, so a row recorded today stays
 * valid for ever, and a restore re-evaluates each row as it is inserted — by
 * which time an `occurred_at` that was within a day of its own insertion is
 * comfortably in the past. The only row that could fail a restore is one dated
 * in the future, which is precisely the row this refuses to accept.
 *
 * The one day of slack is for a timeline entry typed up in a different
 * timezone, which is the ordinary case, not an edge one.
 */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'interaction_not_in_future') THEN
    ALTER TABLE "interaction"
      ADD CONSTRAINT interaction_not_in_future
      CHECK ("occurred_at" <= now() + interval '1 day');
  END IF;
END $$;
