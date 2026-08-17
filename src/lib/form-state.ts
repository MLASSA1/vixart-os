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
