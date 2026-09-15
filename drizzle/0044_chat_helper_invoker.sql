-- VIXART OS — two chat helpers should never have been SECURITY DEFINER.
--
-- Caught by the rule added in 0034, which asserts that every definer function
-- checks its caller. Both of these failed it, and the right answer in each case
-- was not to add a guard but to stop being definer at all.
--
-- app.can_see_message() is the worse of the two, and the bug is subtle.
--
-- It was written so that a file posted into a thread inherits the visibility of
-- whatever the thread is about: general to everyone, a client thread to whoever
-- can see the client. It does that with EXISTS over company and project, which
-- works precisely BECAUSE those tables carry their own row level security —
-- the subquery returns nothing when the caller cannot see the parent.
--
-- As SECURITY DEFINER, all of that is bypassed. The inner EXISTS runs with RLS
-- suspended, finds the row regardless of who is asking, and the function
-- answers the same for everyone. The inheritance it was written to express does
-- not happen.
--
-- Nothing leaks TODAY, because company_select and project_select are both
-- app.is_authenticated() — every signed-in person can already see every client.
-- So the effective answer is the same either way, for now. The day either of
-- those narrows is the day this quietly stops matching them, which is exactly
-- the kind of drift this codebase keeps trying not to accumulate.
--
-- INVOKER, and it becomes true again. There is no recursion risk: it reads
-- message and thread, and it is used only in policies on attachment.
CREATE OR REPLACE FUNCTION app.can_see_message(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
      FROM message m
      JOIN thread t ON t.id = m.thread_id
     WHERE m.id = p_id
  );
$$;

COMMENT ON FUNCTION app.can_see_message(uuid) IS
  'Whether the CALLER can see the message. SECURITY INVOKER on purpose: the '
  'answer comes from the policies on message and thread, which is what makes it '
  'follow the client or project the thread is about.';

-- app.touch_thread_on_message() lifts a thread when a message lands, so the
-- list sorts by real activity. It was definer out of caution about whether the
-- author may update the thread row — they may: thread_update is
-- app.is_real_person(), and someone who just posted is one.
CREATE OR REPLACE FUNCTION app.touch_thread_on_message() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE thread SET updated_at = now() WHERE id = NEW.thread_id;
  RETURN NEW;
END;
$$;
