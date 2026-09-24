'use server';

import { sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { requireClientSession } from '@/auth';
import { withClient } from '@/db/session';
import { describeDbError } from '@/lib/db-errors';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';
import { removeStored, storeUpload } from '@/lib/uploads';

/** The longest thing a client can send in one go. */
const MAX = 4000;

/**
 * A client writes to the team.
 *
 * Note what is NOT here: no thread id from the form, and no company. The
 * thread is looked up on the client's own connection, where exactly one
 * support thread is visible — their own. A thread id taken from a form would
 * be a number the browser chooses, and the only thing standing between it and
 * another client's conversation would be a check in this file.
 *
 * `author_contact_id` is set from the session and `author_id` left null; the
 * policy in 0064 requires both, so a message cannot be attributed to VIXART
 * from here even if this code tried.
 */
export async function sendSupportMessageAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  /*
   * Caught rather than allowed to propagate. A session that expired between
   * loading the page and pressing the button is ordinary — twelve hours is not
   * long — and it should read as "sign in again", not as the application
   * breaking. The thrown version is still correct for anything that is not a
   * form.
   */
  let session;
  try {
    session = await requireClientSession();
  } catch {
    return { error: 'Your session has expired. Sign in again and retry.' };
  }
  if (session.user.mustChangePassword) {
    return { error: 'Choose your password first.' };
  }

  const body = String(formData.get('body') ?? '').trim();
  const file = formData.get('file');
  const hasFile = file instanceof File && file.size > 0;

  // A photograph on its own is a perfectly good message — "it looks like this"
  // — so words are not required when something is attached.
  if (!body && !hasFile) return { error: 'Write something, or attach a file.' };
  if (body.length > MAX) {
    return { error: `That is longer than ${MAX} characters. Send it in two parts.` };
  }

  let messageId: string;
  try {
    messageId = await withClient(session.user.id, async (tx) => {
      const thread = await tx.execute<{ id: string }>(sql`
        SELECT id FROM thread WHERE kind = 'support' LIMIT 1
      `);
      const id = thread.rows[0]?.id;
      if (!id) throw new Error('This conversation is not open yet. Please email us.');

      const written = await tx.execute<{ id: string }>(sql`
        INSERT INTO message (thread_id, author_contact_id, author_name, body)
        VALUES (${id}, ${session.user.id}, ${session.user.name ?? 'Client'},
                ${body || '(file)'})
        RETURNING id
      `);
      const row = written.rows[0];
      if (!row) throw new Error('The message could not be sent.');
      return row.id;
    });
  } catch (error) {
    return { error: describeDbError(error) };
  }

  /*
   * The file second, and the order is the point.
   *
   * The message is already saved by the time the bytes are touched, so a file
   * that is too large or of a type we do not accept costs the client their
   * attachment and not the sentence they wrote. The reverse — refusing the
   * whole post because the photograph was 30 MB — is how somebody retypes a
   * paragraph they had already sent.
   *
   * `storeUpload` enforces the ceiling and the type list on the server, so the
   * `accept` attribute in the browser is a convenience and never the control.
   */
  if (hasFile) {
    let stored;
    try {
      stored = await storeUpload(file);
    } catch (error) {
      revalidatePath('/portal/support');
      return {
        error: null,
        notice: `Message sent, but the file was not: ${
          error instanceof Error ? error.message : 'it could not be stored.'
        }`,
      };
    }

    try {
      await withClient(session.user.id, async (tx) => {
        /*
         * `uploaded_by_id` is left out, because a client is not a member of
         * staff and 0067's policy refuses the row if it claims one. Which
         * message this belongs to is checked there too, against
         * `author_contact_id` — so this cannot be bolted onto something we
         * wrote even if the id were tampered with.
         */
        await tx.execute(sql`
          INSERT INTO attachment
            (entity_type, entity_id, original_name, stored_path, mime_type, size_bytes)
          VALUES ('message', ${messageId}, ${file.name}, ${stored.storedPath},
                  ${stored.mimeType}, ${String(stored.sizeBytes)})
        `);
      });
    } catch (error) {
      // Nothing points at the bytes, so they are removed rather than left to
      // sit in the uploads volume for ever.
      await removeStored(stored.storedPath);
      revalidatePath('/portal/support');
      return {
        error: null,
        notice: `Message sent, but the file was not: ${describeDbError(error)}`,
      };
    }
  }

  revalidatePath('/portal/support');
  return EMPTY_STATE;
}
