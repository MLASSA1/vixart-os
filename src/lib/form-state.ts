/**
 * Shared form state for the CRM forms.
 *
 * Deliberately NOT in `actions.ts`: a `'use server'` module may only export
 * async functions. A plain object or a type exported from there breaks the
 * build with "A 'use server' file can only export async functions".
 */

export interface FormState {
  error: string | null;
  /**
   * The work went through, but there is something to say about it — a message
   * posted whose attachment was refused, a mention that landed on nobody.
   *
   * Separate from `error` because the forms reset on `!error`, and a success
   * dressed as a failure leaves the text sitting in the box where it invites a
   * second, duplicate send.
   */
  notice?: string | null;
}

export const EMPTY_STATE: FormState = { error: null };

/**
 * A form result that also carries a one-time secret back to the screen — the
 * generated password for a new account, or a reset.
 *
 * Lives here rather than in the team actions module because a `"use server"`
 * file may only export async functions; exporting the constant from there is a
 * build error, and one that only appears at build time.
 */
export interface TeamState extends FormState {
  createdPassword?: string;
  createdFor?: string;
}

export const EMPTY_TEAM_STATE: TeamState = { error: null };
