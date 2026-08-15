import Link from 'next/link';
import { TASK_PRIORITY_LABELS, TASK_STATUS_LABELS } from '@/lib/labels';
import { formatDate } from '@/lib/format';
import { setTaskStatusAction, deleteTaskAction } from '@/app/(app)/projects/actions';

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
}

/**
 * Priority without colour: urgency is weight and rule thickness.
 * Only `urgent` inverts, so a board of urgent tasks still reads as a warning.
 */
const PRIORITY_STYLE: Record<string, string> = {
  urgent: 'bg-void text-pure border border-void font-semibold',
  high: 'border-2 border-void font-medium',
  normal: 'border border-void/40',
  low: 'border border-void/25 text-void/55',
};

const STATUS_STYLE: Record<string, string> = {
  todo: 'border border-void/40',
  in_progress: 'border-2 border-void',
  submitted: 'border-2 border-dashed border-void',
  completed: 'bg-void text-pure border border-void',
};

/** Which moves this viewer may make. The database enforces the same rule. */
function nextStatuses(status: string, isMine: boolean, canModerate: boolean): string[] {
  if (canModerate) {
    if (status === 'completed') return ['in_progress'];
    if (status === 'submitted') return ['completed', 'in_progress'];
    return ['in_progress', 'submitted', 'completed'].filter((s) => s !== status);
  }
  if (!isMine || status === 'completed') return [];
  if (status === 'todo') return ['in_progress'];
  if (status === 'in_progress') return ['submitted'];
  if (status === 'submitted') return ['in_progress'];
  return [];
}

export function TaskRow({
  task,
  isMine,
  canModerate,
  showProject = false,
}: {
  task: TaskItem;
  isMine: boolean;
  canModerate: boolean;
  showProject?: boolean;
}) {
  const overdue =
    task.due_date && task.status !== 'completed' && new Date(task.due_date) < new Date();
  const moves = nextStatuses(task.status, isMine, canModerate);

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
            {task.completed_by_name && ` · signed off by ${task.completed_by_name}`}
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
          {moves.map((s) => (
            <form key={s} action={setTaskStatusAction}>
              <input type="hidden" name="taskId" value={task.id} />
              <input type="hidden" name="status" value={s} />
              <button type="submit" className="btn btn-inverse btn-small">
                {s === 'submitted'
                  ? 'Submit for sign-off'
                  : s === 'completed'
                    ? 'Sign off'
                    : TASK_STATUS_LABELS[s]}
              </button>
            </form>
          ))}
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
