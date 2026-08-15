/**
 * Shared form state for the CRM forms.
 *
 * Deliberately NOT in `actions.ts`: a `'use server'` module may only export
 * async functions. A plain object or a type exported from there breaks the
 * build with "A 'use server' file can only export async functions".
 */

export interface FormState {
  error: string | null;
}

export const EMPTY_STATE: FormState = { error: null };
