'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
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
// Tasks
// ---------------------------------------------------------------------------

const taskSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(1, 'A title is required.'),
  description: optionalText,
  assigneeId: optionalText,
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  dueDate: optionalText,
});

export async function createTaskAction(
  projectId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = taskSchema.safeParse({
    projectId,
    title: formData.get('title') ?? '',
    description: formData.get('description') ?? '',
    assigneeId: formData.get('assigneeId') ?? '',
    priority: formData.get('priority') ?? 'normal',
    dueDate: formData.get('dueDate') ?? '',
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

  revalidatePath(`/projects/${projectId}`);
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
  const allowed = ['todo', 'in_progress', 'submitted', 'completed'] as const;
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
