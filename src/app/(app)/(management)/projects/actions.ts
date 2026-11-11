'use server';

import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { project, task } from '@/db/schema';
import { withUser } from '@/db/session';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';
import { describeDbError } from '@/lib/db-errors';

const WORK_ERRORS = {
  task_title_not_empty: 'The task needs a title.',
};

const optionalText = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : v))
  .nullable();


// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const projectSchema = z.object({
  companyId: z.string().uuid('Pick an organisation.'),
  name: z.string().trim().min(1, 'A name is required.'),
  description: optionalText,
  status: z.enum(['planned', 'active', 'on_hold', 'delivered']),
  projectType: z.enum(['branding', 'website', 'ads_campaign', 'video', 'other']),
  startDate: optionalText,
  dueDate: optionalText,
  leadId: optionalText,
});

export async function saveProjectAction(
  projectId: string | null,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = projectSchema.safeParse({
    companyId: formData.get('companyId') ?? '',
    name: formData.get('name') ?? '',
    description: formData.get('description') ?? '',
    status: formData.get('status') ?? 'planned',
    projectType: formData.get('projectType') ?? 'branding',
    startDate: formData.get('startDate') ?? '',
    dueDate: formData.get('dueDate') ?? '',
    leadId: formData.get('leadId') ?? '',
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid form.' };
  }

  try {
    await withUser(async (tx) => {
      if (projectId) {
        await tx.update(project).set(parsed.data).where(eq(project.id, projectId));
      } else {
        await tx.insert(project).values(parsed.data);
      }
    });
  } catch (error) {
    return { error: describeDbError(error, WORK_ERRORS) };
  }

  revalidatePath('/projects');
  revalidatePath('/');
  return EMPTY_STATE;
}

export async function setProjectStatusAction(formData: FormData): Promise<void> {
  const id = String(formData.get('projectId') ?? '');
  const status = String(formData.get('status') ?? '');
  const allowed = ['planned', 'active', 'on_hold', 'delivered'] as const;
  if (!id || !allowed.includes(status as (typeof allowed)[number])) return;

  await withUser(async (tx) => {
    await tx
      .update(project)
      .set({ status: status as (typeof allowed)[number] })
      .where(eq(project.id, id));
  });
  revalidatePath('/projects');
  revalidatePath(`/projects/${id}`);
}

// ---------------------------------------------------------------------------
// Taking a project out of use
// ---------------------------------------------------------------------------

/**
 * Archive, or bring back.
 *
 * `project.archived_at` has existed since 0059, along with the trigger that
 * refuses to delete a project anybody has talked in. Nothing offered either —
 * so a delivered project stayed in every picker forever, and the only way to
 * archive one was a hand-written UPDATE. A rule the database keeps and the
 * interface never mentions is not half-shipped; it is invisible.
 */
export async function setProjectArchivedAction(formData: FormData): Promise<void> {
  const id = String(formData.get('projectId') ?? '');
  const archived = String(formData.get('archived') ?? '') === '1';
  if (!id) return;

  await withUser(async (tx) => {
    await tx.execute(sql`
      UPDATE project SET archived_at = ${archived ? sql`now()` : sql`NULL`}
       WHERE id = ${id}
    `);
  });

  revalidatePath('/projects');
  revalidatePath(`/projects/${id}`);
  revalidatePath('/tasks');
}

/**
 * Delete, when there is genuinely nothing to keep.
 *
 * The typed name is the same confirmation a client asks for, and for the same
 * reason: this removes the project's tasks with it. What it cannot remove is a
 * project with a conversation in it — `project_refuse_deleting_a_record`
 * refuses, and the message says to archive instead.
 */
export async function deleteProjectAction(formData: FormData): Promise<void> {
  const id = String(formData.get('projectId') ?? '');
  const confirmation = String(formData.get('confirmation') ?? '').trim();
  const expected = String(formData.get('expected') ?? '').trim();

  if (!id || expected === '' || confirmation !== expected) return;

  await withUser(async (tx) => {
    await tx.delete(project).where(eq(project.id, id));
  });

  revalidatePath('/projects');
  redirect('/projects');
}

// ---------------------------------------------------------------------------
// What the client sees in the portal (0086)
// ---------------------------------------------------------------------------

/**
 * The one sentence the client reads under "What happens next".
 * Written for them, so it is shown exactly as typed; empty clears it.
 */
export async function setNextStepAction(
  projectId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const text = String(formData.get('nextStep') ?? '').trim();
  if (text.length > 300) return { error: 'Keep it to one or two sentences (300 characters at most).' };
  try {
    await withUser((tx) =>
      tx.execute(sql`
        UPDATE project
           SET next_step = ${text || null},
               next_step_set_at = CASE WHEN ${text || null}::text IS NULL THEN NULL ELSE now() END
         WHERE id = ${projectId}
      `),
    );
  } catch (error) {
    return { error: describeDbError(error) };
  }
  revalidatePath(`/projects/${projectId}`);
  // No notice: NoticeBanner is the "done, with a note" warning, and the saved
  // sentence staying in the box is the confirmation.
  return EMPTY_STATE;
}

/** Share a project file with the client, or stop sharing it. */
export async function shareFileAction(formData: FormData): Promise<void> {
  const attachmentId = String(formData.get('attachmentId') ?? '');
  const projectId = String(formData.get('projectId') ?? '');
  const shared = formData.get('shared') === 'true';
  await withUser((tx) => tx.execute(sql`SELECT app.share_with_client(${attachmentId}::uuid, ${shared})`));
  revalidatePath(`/projects/${projectId}`);
}
