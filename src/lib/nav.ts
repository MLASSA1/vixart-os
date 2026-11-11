/**
 * The map of the application: every screen, its label, its group, and who may
 * see it.
 *
 * It lived inside Shell.tsx, which only the sidebar could read. It is here so
 * that the trail above every page title ("Relationships › Directory") is
 * derived from the SAME list the sidebar draws — the two cannot disagree about
 * what a screen is called or where it lives, because there is only one place
 * that says. Rename a screen here and both change.
 */

export interface NavItem {
  href: string;
  label: string;
  group?: string;
  minRole?: 'admin' | 'moderator';
}

/**
 * Navigation only ever lists what exists. Modules arrive with their step —
 * no greyed-out entries pointing at screens that are not built.
 */
export const NAV: NavItem[] = [
  /*
   * Chat first, for everybody, always. Amin's instruction in those words, and
   * it is the right one: this is the thing the team opens twenty times a day,
   * and it was eighteenth in the list behind sections most of them cannot use.
   */
  { href: '/chat', label: 'Chat' },
  { href: '/inbox', label: 'Inbox' },
  { href: '/attention', label: 'Needs attention' },
  { href: '/my-work', label: 'My work' },

  /*
   * THE TEAM SPACE.
   *
   * What everybody has. Asked for as "move all to team space zone that have
   * tasks schedule prep notes and all features for them" — so this group is the
   * whole of the application for six of the eight people here, and it holds
   * their work and nothing about the company's commerce.
   */
  { href: '/tasks', label: 'Tasks', group: 'Team space' },
  // A person's own week. Moderators can also see the team's, tasks only.
  { href: '/schedule', label: 'Schedule', group: 'Team space' },
  // Where work is thought about before it is assigned. Belongs to whoever is
  // doing the thinking.
  { href: '/prep', label: 'Prep', group: 'Team space' },
  // Private to each person. No moderator or admin view exists, by design.
  { href: '/notes', label: 'Notes', group: 'Team space' },
  { href: '/equipment', label: 'Equipment', group: 'Team space' },
  { href: '/team', label: 'Team', group: 'Team space' },

  /*
   * MANAGEMENT ONLY — Amin and Mohamed Amine.
   *
   * `minRole: 'moderator'` is admin-or-moderator, which is exactly those two
   * and has been since 0006. Everything below this line is the company's
   * commercial business: who the clients are, what is being sold, what it costs
   * and what has been billed.
   *
   * The nav is not what closes them. Every one of these pages lives inside the
   * `(management)` route group, whose layout sends a member to their own work —
   * so a typed url and a stale bookmark get the same answer as a hidden link.
   */
  { href: '/dashboard', label: 'Dashboard', minRole: 'moderator' },

  /*
   * THREE NAMES THAT WERE ONE NAME.
   *
   * These read "Clients", "Leads" and "All clients" — and the first and third
   * are plainly the same word, so the only way to learn which was which was to
   * open both. They are in fact three points on one pipeline, so they are now
   * named and ordered as one: somebody you are chasing, somebody who pays you,
   * and the file drawer holding every record either way.
   *
   * "Directory" rather than "All clients" because the page lists companies
   * that are not clients at all — a lead that went cold is still in it. It is
   * also the word the dashboard already uses for the same set.
   */
  { href: '/leads', label: 'Leads', group: 'Relationships', minRole: 'moderator' },
  { href: '/clients', label: 'Clients', group: 'Relationships', minRole: 'moderator' },
  { href: '/companies', label: 'Directory', group: 'Relationships', minRole: 'moderator' },

  { href: '/projects', label: 'Projects', group: 'Commerce', minRole: 'moderator' },
  { href: '/deals', label: 'Deals', group: 'Commerce', minRole: 'moderator' },
  // The monthly contracts. Beside Deals because it is where a deal goes when it
  // stops being a one-off.
  { href: '/retainers', label: 'Retainers', group: 'Commerce', minRole: 'moderator' },
  // The price list. Not on Amin's list, and moved anyway: leaving every
  // service's price in MAD one click from a member while Finance is closed
  // would be a boundary that only looks like one.
  { href: '/services', label: 'Services', group: 'Commerce', minRole: 'moderator' },
  { href: '/documents', label: 'Quotes & invoices', group: 'Commerce', minRole: 'admin' },
  { href: '/finance', label: 'Finance', group: 'Commerce', minRole: 'admin' },

  { href: '/client-portal', label: 'Client portal', group: 'Agency', minRole: 'moderator' },
  { href: '/system', label: 'System', group: 'Agency', minRole: 'admin' },
];


/** Nav order, grouped. Modules appear as they are built — nothing dead here. */
export const GROUPS = [undefined, 'Team space', 'Relationships', 'Commerce', 'Agency'] as const;

export function visible(item: NavItem, role: 'admin' | 'moderator' | 'member') {
  if (item.minRole === 'admin') return role === 'admin';
  if (item.minRole === 'moderator') return role === 'admin' || role === 'moderator';
  return true;
}

/**
 * Where a path sits in the map: its sidebar entry, that entry's group, and
 * whether this is the entry's own page or something inside it.
 *
 * The longest matching href wins, so `/documents/new` belongs to Quotes &
 * invoices (`/documents`) and not to anything shorter that happens to prefix
 * it. A path the sidebar does not list — `/account` — answers null, and the
 * page simply shows no trail rather than a wrong one.
 */
export function whereAmI(
  pathname: string,
): { item: NavItem; group: string | null; inside: boolean } | null {
  let best: NavItem | null = null;
  for (const item of NAV) {
    const hit = pathname === item.href || pathname.startsWith(`${item.href}/`);
    if (hit && (!best || item.href.length > best.href.length)) best = item;
  }
  if (!best) return null;
  return { item: best, group: best.group ?? null, inside: pathname !== best.href };
}
