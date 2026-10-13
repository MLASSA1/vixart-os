import { describe, expect, it } from 'vitest';
import { CLOSED_TASK_STATUSES, TASK_STATUSES, isOpenTask } from './labels';

/**
 * The predicate that five queries each had their own copy of.
 *
 * Every one of them was written as `status IN ('todo','in_progress')`, which
 * named the open states and so silently dropped `accepted` and `blocked` from
 * the counts and sections it governed — a task vanished from its own project
 * page when somebody pressed Accepted. These tests pin the thing that made it
 * wrong: the list is defined by what is CLOSED, so a status added later is
 * open until somebody says otherwise.
 */
describe('isOpenTask', () => {
  it('calls everything that is not submitted or completed open', () => {
    expect(isOpenTask('todo')).toBe(true);
    expect(isOpenTask('accepted')).toBe(true);
    expect(isOpenTask('in_progress')).toBe(true);
    expect(isOpenTask('blocked')).toBe(true);
  });

  it('calls submitted and completed closed', () => {
    expect(isOpenTask('submitted')).toBe(false);
    expect(isOpenTask('completed')).toBe(false);
  });

  it('covers every status the application knows about', () => {
    // If a status is added to TASK_STATUSES, this test still passes — which is
    // the point of defining the closed set rather than the open one.
    for (const { value } of TASK_STATUSES) {
      expect(typeof isOpenTask(value)).toBe('boolean');
    }
    expect(TASK_STATUSES.map((s) => s.value)).toEqual(
      expect.arrayContaining([...CLOSED_TASK_STATUSES]),
    );
  });

  it('treats a status nobody has defined yet as open', () => {
    expect(isOpenTask('on_hold_pending_client')).toBe(true);
  });
});
