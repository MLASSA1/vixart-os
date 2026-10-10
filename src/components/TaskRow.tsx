import Link from 'next/link';
import { CloseParentButton } from './CloseParentButton';
import { TASK_PRIORITY_LABELS, TASK_STATUS_LABELS } from '@/lib/labels';
import { formatDate } from '@/lib/format';
import { deleteTaskAction, setTaskStatusAction } from '@/app/(app)/tasks/actions';

export interface TaskItem {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  due_date: string | null;
  assignee_name: string | null;
  assignee_id: string | null;
  project_id: string;
  project_name?: string;
  company_name?: string;
  completed_by_name?: string | null;
  /** Sub-tasks not yet signed off. Drives the warning on closing a parent. */
  open_children?: number;
  /** Added in 9A: who raised it, why it is stuck, and its parent if any. */
  created_by_id?: string | null;
  raised_by_name?: string | null;
  blocked_reason?: string | null;
  parent_id?: string | null;
}

/**
 * Priority without colour: urgency is weight and rule thickness.
 * Only `urgent` inverts, so a board of urgent tasks still reads as a warning.
 */
const PRIORITY_STYLE: Record<string, string> = {
  // Red is spent on exactly one thing: work that cannot wait.
  urgent: 'tone-danger font-semibold',
  high: 'tone-warn',
  normal: 'tone-quiet',
  low: 'tone-quiet opacity-70',
};

const STATUS_STYLE: Record<string, string> = {
  todo: 'tone-quiet',
  in_progress: 'tone-accent',
  submitted: 'tone-warn border-dashed',
  completed: 'tone-ok',
};

/** Which moves this viewer may make. The database enforces the same rule. */
/**
 * Where a task can go from here: three buttons, and only ever three.
 *
 * Amin asked for exactly accepted, in progress and completed. What that removed
 * was the submit-for-sign-off step — a member used to be able to reach
 * `submitted` and only a moderator could reach `completed` — and the reason it
 * could go is that 0075 replaced the permission with a notification: the person
 * who did the work says it is done, and whoever raised it plus management are
 * told.
 *
 * A ladder was the old shape (todo → accepted → in progress → submitted), one
 * button at a time. Three is not a ladder, because the real sequence is not one:
 * work gets picked up, put down, picked up again, and a member who had moved a
 * task to "in progress" had no way back to "accepted" without asking somebody.
 * Any of the three, from any state, including back out of completed — with three
 * buttons that is the only way to undo a mis-click, and the database clears the
 * sign-off stamp when they do.
 *
 * NOT IN THIS LIST, and both are still valid states in the database:
 *
 *   `submitted` — two tasks are in it in production, and the three buttons reach
 *     them. Nothing enters it any more.
 *   `blocked` — it carries a written reason, so it never was a one-click button;
 *     its own control is gone with the rest. The attention queue that counts
 *     blocked work stays, because putting the button back is one line and a
 *     queue that cannot fire is cheaper than one that is missing.
 */
const THREE = ['accepted', 'in_progress', 'completed'] as const;

function nextStatuses(status: string, isMine: boolean, canModerate: boolean): string[] {
  // Somebody else's task, and not management: nothing to press.
  if (!isMine && !canModerate) return [];
  return THREE.filter((s) => s !== status);
}

export function TaskRow({
  task,
  isMine,
  canModerate,
  showProject = false,
}: {
  task: TaskItem;
  isMine?: boolean;
  canModerate: boolean;
  showProject?: boolean;
}) {
  const overdue =
    task.due_date && task.status !== 'completed' && new Date(task.due_date) < new Date();
  const moves = nextStatuses(task.status, isMine ?? false, canModerate);

  return (
    <li className="border-b border-void/10 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`px-1.5 py-0.5 text-[12px] ${PRIORITY_STYLE[task.priority]}`}
            >
              {TASK_PRIORITY_LABELS[task.priority]}
            </span>
            <span className="font-semibold">{task.title}</span>
          </div>

          {showProject && task.project_name && (
            <p className="hint mt-0.5">
              <Link
                href={`/projects/${task.project_id}`}
                className="underline underline-offset-4"
              >
                {task.project_name}
              </Link>
              {task.company_name ? ` · ${task.company_name}` : ''}
            </p>
          )}
          {task.description && <p className="hint mt-1 max-w-xl">{task.description}</p>}

          <p className="hint mt-1">
            {task.assignee_name ?? 'Unassigned'}
            {task.due_date && (
              <>
                {' · due '}
                {formatDate(task.due_date)}
                {/* Overdue is stated in words, not signalled in red. */}
                {overdue && <strong className="ml-1 font-semibold">— overdue</strong>}
              </>
            )}
            {/*
              "finished by", not "signed off by". It said the latter when
              completion was a moderator confirming somebody else's word; the
              person named here is now usually the person who did the work, and
              "signed off by Adam" on Adam's own task reads like a formality
              rather than a fact.
            */}
            {task.completed_by_name && ` · finished by ${task.completed_by_name}`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={`px-2 py-0.5 text-[12.5px] font-medium whitespace-nowrap ${
              STATUS_STYLE[task.status]
            }`}
          >
            {TASK_STATUS_LABELS[task.status]}
          </span>
          {moves.map((s) => {
            /*
             * "Completed", not "Sign off".
             *
             * It said "Sign off" because a moderator was confirming somebody
             * else's word. The person pressing it is now the person who did the
             * work, and what they are saying is "this is finished" — so the
             * button says that.
             */
            const label = TASK_STATUS_LABELS[s] ?? s;

            // Closing a parent that still has open sub-tasks asks first. Any
            // other transition is a plain button — a task moving to
            // 'in progress' has nothing to warn about.
            const closes = s === 'completed';
            const openChildren = task.open_children ?? 0;

            if (closes && openChildren > 0) {
              return (
                <form key={s} action={setTaskStatusAction}>
                  <CloseParentButton
                    label={label}
                    openChildren={openChildren}
                    onConfirmName="status"
                    onConfirmValue={s}
                    taskId={task.id}
                  />
                </form>
              );
            }

            return (
              <form key={s} action={setTaskStatusAction}>
                <input type="hidden" name="taskId" value={task.id} />
                <input type="hidden" name="status" value={s} />
                <button type="submit" className="btn btn-inverse btn-small">
                  {label}
                </button>
              </form>
            );
          })}
          {canModerate && (
            <form action={deleteTaskAction}>
              <input type="hidden" name="taskId" value={task.id} />
              <input type="hidden" name="projectId" value={task.project_id} />
              <button type="submit" className="hint cursor-pointer underline underline-offset-4">
                Delete
              </button>
            </form>
          )}
        </div>
      </div>
    </li>
  );
}
