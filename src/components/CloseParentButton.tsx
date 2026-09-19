'use client';

import { useState } from 'react';
import { useFormStatus } from 'react-dom';

/**
 * Closing a task that still has open sub-tasks.
 *
 * The database allows it deliberately — sometimes the remaining pieces genuinely
 * do not matter, and a hard block would have people deleting sub-tasks to get
 * past it, which loses the record of what was dropped.
 *
 * But it is also exactly what somebody does by accident, and until now nothing
 * said so. So it asks once, names the number, and then gets out of the way.
 * The confirmation is a second click, not a modal: the answer is almost always
 * yes, and a dialog for a routine action trains people to dismiss dialogs.
 */
export function CloseParentButton({
  label,
  openChildren,
  onConfirmName,
  onConfirmValue,
  taskId,
}: {
  label: string;
  openChildren: number;
  /** The hidden field the parent form submits. */
  onConfirmName: string;
  onConfirmValue: string;
  taskId: string;
}) {
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <button
        type="button"
        className="btn btn-inverse btn-small"
        onClick={() => setAsking(true)}
      >
        {label}
      </button>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="tone-warn rounded-[8px] px-2.5 py-1 text-[13px]">
        {openChildren === 1
          ? 'One sub-task is still open.'
          : `${openChildren} sub-tasks are still open.`}{' '}
        Close this anyway?
      </span>
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name={onConfirmName} value={onConfirmValue} />
      <Confirm />
      <button
        type="button"
        className="hint cursor-pointer underline underline-offset-4"
        onClick={() => setAsking(false)}
      >
        Cancel
      </button>
    </span>
  );
}

function Confirm() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-small" disabled={pending}>
      {pending ? 'Closing…' : 'Close it'}
    </button>
  );
}
