/*
 * Where to find a client online, on the client's own page.
 *
 * Amin, November 2026: each client should have its own page showing everything
 * worth knowing about them, and "social and links" was one of the three things
 * he named as missing. The company already had `website`; an agency that makes
 * brand films and social campaigns also needs the client's Instagram, their
 * Facebook page, where they are on Google Maps, and the page their customers
 * book or order through — the places a shoot is planned from and a campaign
 * points at.
 *
 * FOUR COLUMNS, NOT A LINKS TABLE. These are four specific, named places, each
 * shown with its own label. A generic table of (label, url) rows would invite
 * "insta", "Instagram" and "IG" for the same thing, and a page that cannot know
 * which row is the map.
 *
 * SHAPE CHECKED HERE, as well as in the form. A link is only useful if it opens,
 * so each must be an http(s) address; 2,000 characters is well past any real
 * one and stops a pasted essay. The form normalises "instagram.com/x" to
 * "https://instagram.com/x" before it gets this far — this is the rule, the
 * form is the courtesy.
 *
 * No grants and no policies to add: `company` is granted table-wide and its row
 * level security is per row, so the new columns inherit both. The activity
 * trigger logs inserts and status changes only, so it is unaffected.
 *
 * Additive only: nothing existing is altered, and every new value starts NULL.
 */

ALTER TABLE company
  ADD COLUMN IF NOT EXISTS instagram_url text
    CONSTRAINT company_instagram_url_shape
    CHECK (instagram_url IS NULL OR (instagram_url ~* '^https?://' AND length(instagram_url) <= 2000));
--> statement-breakpoint

ALTER TABLE company
  ADD COLUMN IF NOT EXISTS facebook_url text
    CONSTRAINT company_facebook_url_shape
    CHECK (facebook_url IS NULL OR (facebook_url ~* '^https?://' AND length(facebook_url) <= 2000));
--> statement-breakpoint

ALTER TABLE company
  ADD COLUMN IF NOT EXISTS maps_url text
    CONSTRAINT company_maps_url_shape
    CHECK (maps_url IS NULL OR (maps_url ~* '^https?://' AND length(maps_url) <= 2000));
--> statement-breakpoint

ALTER TABLE company
  ADD COLUMN IF NOT EXISTS booking_url text
    CONSTRAINT company_booking_url_shape
    CHECK (booking_url IS NULL OR (booking_url ~* '^https?://' AND length(booking_url) <= 2000));
--> statement-breakpoint

COMMENT ON COLUMN company.instagram_url IS 'The client''s Instagram profile (0082).';
--> statement-breakpoint
COMMENT ON COLUMN company.facebook_url IS 'The client''s Facebook page (0082).';
--> statement-breakpoint
COMMENT ON COLUMN company.maps_url IS 'Where the client is on Google Maps (0082).';
--> statement-breakpoint
COMMENT ON COLUMN company.booking_url IS 'The page the client''s customers book or order through (0082).';
