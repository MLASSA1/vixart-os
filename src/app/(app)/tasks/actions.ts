'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { task } from '@/db/schema';
import { withUser } from '@/db/session';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';
import { describeDbError } from '@/lib/db-errors';

/**
 * Raising and moving work.
 *
 * These used to live in the projects folder, beside the actions that create and
 * archive a project, because a task was something that happened inside one.
 * Two things made that wrong. Since 0055 a task does not need a project at all
 * — fixing the studio lighting is work — and since the team space was closed
 * off, `/projects` is management's and `/tasks` is everybody's. A member
 * raising a task would have been importing from a folder they cannot open.
 *
 * Nothing here is a security check. The database decides what a task may
 * become: `app.enforce_task_signoff` lets only the assignee move their own
 * task and only a moderator reach `completed`, and it raises if either rule is
 * broken. These functions exist to turn that into a sentence somebody can read.
 */

const WORK_ERRORS = {
  task_title_not_empty: 'The task needs a title.',
};

const optionalText = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : v))
  .nullable();

const taskSchema = z.object({
  projectId: z.string().uuid().nullable(),
  title: z.string().trim().min(1, 'A title is required.'),
  description: optionalText,
  assigneeId: optionalText,
  parentId: optionalText,
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  dueDate: optionalText,
});

/**
 * Raise a task.
 *
 * `projectId` is bound when this is called from a project page. From /tasks it
 * is bound null and read from the form instead, where it is optional: since
 * 0055 a task does not have to belong to a client engagement. Fixing the
 * studio lighting is work; it is not a project.
 */
export async function createTaskAction(
  projectId: string | null,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const fromForm = String(formData.get('projectId') ?? '').trim();
  const project = projectId ?? (fromForm || null);
  const parsed = taskSchema.safeParse({
    projectId: project,
    title: formData.get('title') ?? '',
    description: formData.get('description') ?? '',
    assigneeId: formData.get('assigneeId') ?? '',
    priority: formData.get('priority') ?? 'normal',
    dueDate: formData.get('dueDate') ?? '',
    parentId: formData.get('parentId') ?? '',
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid form.' };
  }

  try {
    await withUser(async (tx, user) => {
      await tx.insert(task).values({ ...parsed.data, createdById: user.id });
    });
  } catch (error) {
    return { error: describeDbError(error, WORK_ERRORS) };
  }

  if (project) revalidatePath(`/projects/${project}`);
  revalidatePath('/tasks');
  revalidatePath('/my-work');
  revalidatePath('/');
  return EMPTY_STATE;
}

/**
 * Move a task along. The database decides what is allowed: a member can reach
 * `submitted`, only a moderator can reach `completed`, and the trigger raises
 * if either rule is broken. Nothing here is a security check — it is only a
 * route to a readable message.
 */
export async function setTaskStatusAction(formData: FormData): Promise<void> {
  const id = String(formData.get('taskId') ?? '');
  const status = String(formData.get('status') ?? '');
  const allowed = ['todo', 'accepted', 'in_progress', 'submitted', 'completed'] as const;
  if (!id || !allowed.includes(status as (typeof allowed)[number])) return;

  await withUser(async (tx) => {
    await tx
      .update(task)
      .set({ status: status as (typeof allowed)[number] })
      .where(eq(task.id, id));
  });

  revalidatePath('/my-work');
  revalidatePath('/projects');
  revalidatePath('/');
}

/*
 * `blockTaskAction` was here and is gone with the button.
 *
 * Amin's three buttons are accepted, in progress and completed, and blocking
 * carried a written reason so it never was one of them. An exported server
 * action is a live endpoint whether or not anything calls it, and a mutation
 * nothing can reach is worth removing rather than leaving for somebody to find.
 *
 * `blocked` is still a valid status and the attention queue that counts it
 * stays, so putting this back is one revert.
 */
export async function deleteTaskAction(formData: FormData): Promise<void> {
  const id = String(formData.get('taskId') ?? '');
  const projectId = String(formData.get('projectId') ?? '');
  if (!id) return;
  await withUser(async (tx) => {
    await tx.delete(task).where(eq(task.id, id));
  });
  if (projectId) revalidatePath(`/projects/${projectId}`);
  revalidatePath('/my-work');
}

