/**
 * Where a signed-in person belongs when no particular page was asked for.
 *
 * One function, because there were four answers to this question scattered
 * around and three of them were the same wrong one. The wordmark pointed at
 * /dashboard, the root redirected to /dashboard, the sign-in page sent an
 * already-signed-in visitor to /clients, and /system sent a non-admin to
 * /clients — all written when every member of staff could open every page.
 *
 * Since the team space, a member can open none of those. Each of them still
 * "worked", because the management layout catches them and redirects again, and
 * that is exactly the failure worth naming: the application would bounce
 * somebody twice on the way to their own work, and the first hop would be a
 * place they are not allowed. It looks like a glitch and it reads as one.
 */
export type Role = 'admin' | 'moderator' | 'member';

export function homeFor(role: Role): string {
  return role === 'member' ? '/my-work' : '/dashboard';
}
