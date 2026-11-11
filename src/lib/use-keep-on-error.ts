'use client';

import { useCallback, useEffect, useRef, type FormEvent } from 'react';

/**
 * Keep what somebody typed when the server refuses the save.
 *
 * React 19 resets a `<form action={…}>` after its action settles — success or
 * not. On success that is what we want: an "Add a contact" form should come
 * back empty. On a refusal it is the opposite: one bad field ("That does not
 * look like a web address") emptied every other field too, valid ones
 * included, and they all had to be typed again. Found on the client edit form
 * in November 2026; every one of the application's 47 forms behaved the same.
 *
 * WHY NOT CANCEL THE RESET. The obvious fix — cancel the browser's `reset`
 * event when the action failed — was tried and measured: the event fires and
 * is cancellable, but React resets the form in an EARLIER commit than the one
 * that renders the new error state, so at the moment of the reset nothing yet
 * knows the save was refused. A guard that looked right and could never fire.
 *
 * WHAT THIS DOES INSTEAD. It records every field's value at the moment the
 * form is submitted, and once the refusal has actually rendered, puts them
 * back. A save that succeeds restores nothing, so forms still clear exactly
 * as they did. A file input cannot be refilled by a page (browsers forbid it),
 * so a chosen file does have to be chosen again.
 *
 *   const [state, formAction] = useActionState(action, EMPTY_STATE);
 *   const keepState = useKeepOnError(state);
 *   <form action={formAction} onSubmit={keepState}>
 */

type Snapshot = { form: HTMLFormElement; values: Array<{ el: Element; value: string; checked: boolean }> };

export function useKeepOnError(state: { error?: string | null } | null | undefined) {
  const snapshot = useRef<Snapshot | null>(null);

  // On submit: remember what is in every field. Runs before React hands the
  // form to the action, so it sees exactly what was typed.
  const onSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    const form = event.currentTarget;
    snapshot.current = {
      form,
      values: [...form.elements]
        .filter((el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)
        .filter((el) => !(el instanceof HTMLInputElement && (el.type === 'file' || el.type === 'hidden' || el.type === 'submit' || el.type === 'button')))
        .map((el) => ({
          el,
          value: (el as HTMLInputElement).value,
          checked: el instanceof HTMLInputElement ? el.checked : false,
        })),
    };
  }, []);

  // After the refusal has rendered — which is after React's reset — put it back.
  useEffect(() => {
    const taken = snapshot.current;
    if (!state?.error || !taken) return;
    for (const { el, value, checked } of taken.values) {
      if (!taken.form.contains(el)) continue; // the form changed shape; leave it
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) el.checked = checked;
      else (el as HTMLInputElement).value = value;
    }
    snapshot.current = null;
  }, [state]);

  return onSubmit;
}
