-- VIXART OS — one constraint for what can carry an attachment, not two.
--
-- `attachment` had TWO CHECK constraints listing the same thing:
--
--   attachment_entity_type_valid  task, project, company, document,
--                                 finance_entry, contact, prep, message
--   attachment_entity_valid       task, project, company, document,
--                                 finance_entry, contact
--
-- Both had to pass, so the effective rule was the narrower one — and every
-- extension since has been written into the wrong half. That is not a
-- hypothetical: PREP ATTACHMENTS HAVE NEVER WORKED. The prep board shipped
-- with a References section, `prep` was added to one list in 0037, and the
-- other list silently refused every upload. Nothing caught it because no test
-- ever attached a file to a prep, and nobody has used the feature yet.
--
-- Found when the chat tests attached a file to a message and hit the same wall.
--
-- Two constraints enforcing one rule is how they drift apart. The duplicate
-- goes; the surviving one is named for what it does and is the only place this
-- list is ever edited again.
ALTER TABLE attachment DROP CONSTRAINT attachment_entity_valid;

-- Restated here so this file alone says what the rule now is, rather than
-- leaving a reader to reconstruct it from 0037 and 0042.
ALTER TABLE attachment DROP CONSTRAINT attachment_entity_type_valid;
ALTER TABLE attachment ADD CONSTRAINT attachment_entity_type_valid CHECK (
  entity_type IN (
    'task','project','company','contact',   -- the work and the people
    'document','finance_entry',             -- money, admin only
    'prep',                                 -- video preparation
    'message'                               -- posted into a chat thread
  )
);
