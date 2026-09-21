-- =============================================================================
-- 0066 — The twenty-five systems, as the website states them.
--
-- WHY THIS IS NOT THE `service` TABLE.
--
-- `service` is the BILLING catalogue. `document_line`, `deal_line` and
-- `service_price` all point at it, which means its rows are referenced by
-- issued invoices — fiscal records that must not move under them. It holds
-- nine broad lines ("Cinematic production", "Growth marketing") because that
-- is the grain an invoice is written at.
--
-- These twenty-five are the public catalogue: what visionxart.com tells a
-- client VIXART does, in the words it uses there. Different grain, different
-- audience, different lifetime — and folding them into `service` would either
-- rewrite rows an invoice depends on, or leave the billing catalogue with
-- twenty-five entries nobody quotes from.
--
-- Two tables, one of which can be republished from the website whenever the
-- website changes, and the other of which cannot change at all.
-- =============================================================================

CREATE TABLE growth_system (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The website's own slug. This is the join between the two, so that
  -- re-importing updates a system rather than duplicating it.
  slug           text NOT NULL UNIQUE,
  name           text NOT NULL,
  family         text NOT NULL,
  -- Position WITHIN the family, as numbered on the site.
  position       integer NOT NULL,

  what_it_fixes  text NOT NULL,
  what_it_is     text NOT NULL,
  -- The numbered list. An array rather than a child table: it is read whole,
  -- written whole, never queried into, and never referenced by anything.
  what_you_get   text[] NOT NULL DEFAULT '{}',
  who_it_is_for  text NOT NULL,

  -- Filename under /systems. Null for the seventeen the site does not
  -- illustrate — the portal shows none where the website shows none.
  image          text,

  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT growth_system_family_valid
    CHECK (family IN ('Growth', 'Engineering', 'Production', 'Design')),
  CONSTRAINT growth_system_one_per_position UNIQUE (family, position)
);

COMMENT ON TABLE growth_system IS
  'The public catalogue as stated on visionxart.com. Not `service`, which is '
  'the billing catalogue and is referenced by issued invoices.';

CREATE INDEX growth_system_family_idx ON growth_system (family, position);

ALTER TABLE growth_system ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_system FORCE ROW LEVEL SECURITY;

CREATE POLICY growth_system_bootstrap ON growth_system
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());

-- Everyone on the team can read it; it is what they sell.
CREATE POLICY growth_system_select ON growth_system FOR SELECT
  USING (app.is_real_person());

-- Changing what the agency says it does is a management decision.
CREATE POLICY growth_system_write ON growth_system FOR INSERT
  WITH CHECK (app.is_moderator());
CREATE POLICY growth_system_update ON growth_system FOR UPDATE
  USING (app.is_moderator()) WITH CHECK (app.is_moderator());
CREATE POLICY growth_system_delete ON growth_system FOR DELETE
  USING (app.is_admin());

-- And the clients, who are the reason it is in the portal at all. Nothing here
-- belongs to one client, so there is nothing to scope by company: the only
-- rule is that a retired system stops being shown.
CREATE POLICY growth_system_client_select ON growth_system FOR SELECT
  TO vixart_client USING (is_active);

GRANT SELECT ON growth_system TO vixart_client;

CREATE TRIGGER growth_system_touch_updated_at
  BEFORE UPDATE ON growth_system
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
