'use server';

import { sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { requireSession } from '@/auth';
import { withUser } from '@/db/session';
import { describeDbError } from '@/lib/db-errors';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';
import { removeStored, storeUpload } from '@/lib/uploads';
import { isImage, needsSafari } from '@/lib/upload-types';

/** The longest description the column will take (0072). */
const MAX_BIO = 600;

/**
 * A person editing their own profile.
 *
 * No role check here, and that is not an omission. `app_user_update` admits
 * `id = app.current_user_id()`, and `app_user_team_rules` (0021) refuses a
 * self-edit of role, is_active or email — so the database already says exactly
 * what somebody may change about themselves, and a check written here would be
 * a second opinion free to drift from it. Every statement below is scoped to the
 * session's own id, so there is nothing to aim anywhere else.
 *
 * `job_title` is deliberately not editable here. It is the company's statement
 * about somebody rather than their own, and an admin sets it on the team page.
 */
export async function saveMyProfileAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  // Rejects an unauthenticated caller. The id used below comes from withUser.
  await requireSession();

  const fullName = String(formData.get('fullName') ?? '').trim();
  const rawBio = String(formData.get('bio') ?? '').trim();
  const bio = rawBio === '' ? null : rawBio;

  if (!fullName) return { error: 'A name is required — it is what your colleagues see.' };
  if (fullName.length > 120) return { error: 'That name is too long.' };
  if (bio && bio.length > MAX_BIO) {
    return {
      error: `That description is ${bio.length} characters. The limit is ${MAX_BIO} — ` +
        `it sits beside your name, not on a page of its own.`,
    };
  }

  try {
    await withUser(async (tx, user) => {
      await tx.execute(sql`
        UPDATE app_user
           SET full_name = ${fullName}, bio = ${bio}
         WHERE id = ${user.id}
      `);
    });
  } catch (error) {
    return { error: describeDbError(error, {
      app_user_bio_sane: `A description can be up to ${MAX_BIO} characters.`,
    }) };
  }

  const pictures = await saveImages(formData);

  /*
   * The name is in the session token, which is issued at sign-in and not
   * re-read per request. So the sidebar keeps the old name until the token is
   * next minted — said plainly rather than left for somebody to think the save
   * failed.
   */
  revalidatePath('/account');
  revalidatePath('/team');

  if (pictures.error) return { error: null, notice: pictures.error };
  return {
    error: null,
    notice:
      pictures.changed
        ? 'Saved. Your name in the sidebar updates the next time you sign in.'
        : 'Saved.',
  };
}

/**
 * The picture and the banner.
 *
 * Done after the text and reported as a NOTICE rather than an error, for the
 * same reason a chat message keeps its words when its attachment is refused:
 * somebody who has just rewritten their description should not lose it because
 * the photograph they chose was 30 MB.
 *
 * Delete then insert, because `attachment_one_per_person` (0072) allows exactly
 * one of each — which is the point. Replacing a picture must not leave the old
 * row behind for a join to find later.
 */
async function saveImages(formData: FormData): Promise<{ changed: boolean; error: string | null }> {
  let changed = false;
  const problems: string[] = [];

  for (const [field, kind, label] of [
    ['avatar', 'user_avatar', 'picture'],
    ['banner', 'user_banner', 'banner'],
  ] as const) {
    const remove = String(formData.get(`${field}Remove`) ?? '') === '1';
    const file = formData.get(field);
    const hasFile = file instanceof File && file.size > 0;

    if (!remove && !hasFile) continue;

    if (hasFile) {
      /*
       * A picture, and one a browser will actually draw.
       *
       * `storeUpload` would happily accept a PDF here — it is the general file
       * rule — and a profile with a spreadsheet where its face should be is a
       * thing somebody would do once by accident and never understand. HEIC is
       * refused for the same practical reason it is refused in chat: an iPhone
       * on High Efficiency produces it, and only Safari can decode it, so the
       * picture would be invisible to most of the team.
       */
      if (!isImage(file.type)) {
        problems.push(`Your ${label} was not changed: choose an image.`);
        continue;
      }
      if (needsSafari(file.type)) {
        problems.push(
          `Your ${label} was not changed: that is an iPhone HEIC image, which ` +
            `most browsers cannot display. Set Camera → Formats to "Most ` +
            `Compatible", or send a JPEG.`,
        );
        continue;
      }
    }

    let stored: Awaited<ReturnType<typeof storeUpload>> | null = null;
    if (hasFile) {
      try {
        stored = await storeUpload(file);
      } catch (error) {
        problems.push(
          `Your ${label} was not changed: ` +
            (error instanceof Error ? error.message : 'it could not be stored.'),
        );
        continue;
      }
    }

    try {
      await withUser(async (tx, user) => {
        // The old one goes whether it is being replaced or simply removed.
        await tx.execute(sql`
          DELETE FROM attachment
           WHERE entity_type = ${kind} AND entity_id = ${user.id}
        `);
        if (stored) {
          await tx.execute(sql`
            INSERT INTO attachment
              (entity_type, entity_id, original_name, stored_path, mime_type,
               size_bytes, uploaded_by_id)
            VALUES (${kind}, ${user.id}, ${(file as File).name}, ${stored.storedPath},
                    ${stored.mimeType}, ${String(stored.sizeBytes)}, ${user.id})
          `);
        }
      });
      changed = true;
    } catch (error) {
      // The row failed, so nothing points at the bytes.
      if (stored) await removeStored(stored.storedPath);
      problems.push(`Your ${label} was not changed: ${describeDbError(error)}`);
    }
  }

  return { changed, error: problems.length > 0 ? problems.join(' ') : null };
}
