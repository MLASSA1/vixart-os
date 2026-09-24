'use client';

import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { EMPTY_STATE } from '@/lib/form-state';
import { setProjectProgressAction } from './actions';

function Save({ changed }: { changed: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending || !changed}>
      {pending ? 'Saving…' : 'Save'}
    </button>
  );
}

/**
 * The figure a client reads, and the two buttons that move it.
 *
 * Amin asked to be able to add to it or take from it, so the steps are the
 * control and the field is there for an exact number. Ten at a time, because
 * the number is a reassurance to somebody outside the company and not a
 * measurement — nudging it by one would suggest a precision that does not
 * exist.
 *
 * Held in local state and saved on purpose, rather than saved as it moves: this
 * is a number a client sees, and a slider that wrote on every pixel would
 * publish every intermediate value on the way to the one that was meant.
 */
export function ProgressControl({
  projectId,
  percent,
  byHand,
  fromTasks,
}: {
  projectId: string;
  /** What is shown now — the hand-set figure, or the task count. */
  percent: number;
  byHand: boolean;
  /** What the tasks say, or null when there are none. */
  fromTasks: number | null;
}) {
  const [state, formAction] = useActionState(setProjectProgressAction, EMPTY_STATE);
  const [value, setValue] = useState(percent);

  // Follow the server once it has answered, so a save that was rejected does
  // not leave the field showing a number that was never stored.
  useEffect(() => setValue(percent), [percent]);

  const step = (by: number) =>
    setValue((v) => Math.min(100, Math.max(0, Math.round(v + by))));

  const changed = value !== percent || !byHand;

  return (
    <div className="mt-3">
      {state.error && (
        <p role="alert" className="tone-danger mb-3 rounded-[10px] px-3 py-2 text-[13.5px]">
          {state.error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div
          className="h-[6px] w-full max-w-[280px] overflow-hidden rounded-full bg-void/10"
          role="progressbar"
          aria-valuenow={value}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Progress shown to the client"
        >
          <span
            className="block h-full rounded-full bg-accent"
            style={{ width: `${value}%` }}
          />
        </div>

        <form action={formAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="projectId" value={projectId} />
          {/* The field the action reads. The steps below only move it. */}
          <input
            type="number"
            name="percent"
            min={0}
            max={100}
            value={value}
            onChange={(e) => {
              const n = Number(e.currentTarget.value);
              setValue(Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0);
            }}
            aria-label="Progress percentage"
            className="w-[76px] rounded-[10px] border border-void/15 bg-paper px-2.5 py-1.5 text-[14px] tabular-nums"
          />
          <span className="text-[14px]" style={{ opacity: 0.6 }}>%</span>

          <button
            type="button"
            onClick={() => step(-10)}
            className="rounded-[9px] border border-void/15 px-2.5 py-1.5 text-[14px] font-semibold hover:bg-void/[0.04]"
            aria-label="Ten less"
          >
            −10
          </button>
          <button
            type="button"
            onClick={() => step(10)}
            className="rounded-[9px] border border-void/15 px-2.5 py-1.5 text-[14px] font-semibold hover:bg-void/[0.04]"
            aria-label="Ten more"
          >
            +10
          </button>

          <Save changed={changed} />
        </form>

        {byHand && (
          /*
           * Going back is one button. A hand-set figure that nobody clears
           * stops tracking the work the moment the team gets on with it, so the
           * way back to the count must not be a database visit.
           */
          <form action={formAction}>
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="percent" value="" />
            <button type="submit" className="text-[13.5px] underline underline-offset-2">
              {fromTasks === null
                ? 'Clear it'
                : `Go back to counting tasks (${fromTasks}%)`}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
