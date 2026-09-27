import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The commercial half of the application is behind one guarded door.
 *
 * Amin asked, twice in one message, that everybody except him and Mohamed Amine
 * lose the client list, the leads, the projects board, the dashboard, the money,
 * the quotes and invoices and the retainers.
 *
 * There were twelve sections to close and there will be more, so the guard is
 * not twelve copies of a role check — it is a route group, `(management)`, whose
 * layout redirects a member to their own work. A page is protected by WHERE IT
 * IS, which means the page nobody has written yet is protected too.
 *
 * What that trades away is loudness. A new section put in the wrong folder is
 * open, and looks exactly like one put in the right folder: it renders, it works,
 * and the only person who would notice is a member who went looking. So the
 * arrangement itself is checked here — that the door exists, that it redirects,
 * and that none of the sections behind it has escaped.
 */

const APP = join(process.cwd(), 'src/app/(app)');
const MANAGEMENT = join(APP, '(management)');

/** Every section that must be management's, by its url. */
const COMMERCIAL = [
  'dashboard',
  'clients',
  'leads',
  'companies',
  'projects',
  'deals',
  'retainers',
  'services',
  'documents',
  'finance',
  'system',
  'client-portal',
];

/** Every section a member must keep. */
const TEAM = [
  'chat',
  'inbox',
  'attention',
  'my-work',
  'tasks',
  'schedule',
  'prep',
  'notes',
  'team',
  'equipment',
  'account',
];

describe('the team space and the management door', () => {
  it('has a layout on the management group that redirects', () => {
    const layout = join(MANAGEMENT, 'layout.tsx');
    expect(existsSync(layout), 'the (management) layout is gone — every section behind it is open').toBe(true);

    const source = readFileSync(layout, 'utf8');
    // Redirect, not throw: a member following an old bookmark has done nothing
    // wrong, and a thrown error would show them Next's error screen.
    expect(source).toContain('redirect(');
    expect(source).toMatch(/role !== 'admin' && role !== 'moderator'/);
    // Somewhere they can actually go.
    expect(source).toContain("'/my-work'");
  });

  it('keeps every commercial section inside it', () => {
    const outside = COMMERCIAL.filter((name) => existsSync(join(APP, name)));
    expect(
      outside,
      `\nThese sections sit directly under (app), so NO role check applies:\n` +
        `  ${outside.join(', ')}\n` +
        `Move them into src/app/(app)/(management)/.\n`,
    ).toEqual([]);

    const missing = COMMERCIAL.filter((name) => !existsSync(join(MANAGEMENT, name)));
    expect(missing, `\nThese are not in the management group at all:\n  ${missing.join(', ')}\n`).toEqual([]);
  });

  it('leaves the team’s own sections reachable', () => {
    // The other half. A guard that swallowed /tasks would pass the test above
    // and take the team's work with it.
    const swallowed = TEAM.filter((name) => existsSync(join(MANAGEMENT, name)));
    expect(
      swallowed,
      `\nThese are behind the management door and should not be:\n  ${swallowed.join(', ')}\n`,
    ).toEqual([]);

    const gone = TEAM.filter((name) => !existsSync(join(APP, name)));
    expect(gone, `\nThese sections have disappeared:\n  ${gone.join(', ')}\n`).toEqual([]);
  });

  it('never imports management code from a member’s page', () => {
    /*
     * The subtler failure, and one that already happened: the task actions lived
     * in the projects folder, because a task used to be something inside a
     * project. When projects moved, `/tasks` — which every member uses — was
     * importing from a folder they cannot open. It compiled, because a route
     * group is not a module boundary.
     *
     * A member's page reaching into `(management)` is either a build error
     * waiting to happen or a piece of management logic in the wrong place.
     */
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === '(management)') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(entry)) continue;
        const source = readFileSync(full, 'utf8');
        if (/from '[^']*\(management\)/.test(source)) {
          offenders.push(full.replace(process.cwd() + '/', ''));
        }
      }
    };
    walk(APP);

    expect(
      offenders,
      `\nThese files a member can reach import from (management):\n  ${offenders.join('\n  ')}\n`,
    ).toEqual([]);
  });

  it('sends a member somewhere they can open, from one place', () => {
    /*
     * There were four answers to "where does a signed-in person go", and three
     * were the same wrong one: the wordmark and the root pointed at /dashboard,
     * the sign-in page sent an already-signed-in visitor to /clients, and
     * /system sent a non-admin to /clients. All four predate the team space and
     * none of them is open to a member.
     *
     * Each still "worked", because the management layout catches it and
     * redirects again — which is the failure worth naming: two hops to reach
     * your own work, the first into somewhere you are not allowed. It reads as
     * the application being broken.
     */
    const home = readFileSync(join(process.cwd(), 'src/lib/home.ts'), 'utf8');
    expect(home).toContain("role === 'member' ? '/my-work'");

    for (const file of [
      'src/app/page.tsx',
      'src/app/sign-in/page.tsx',
      'src/app/(app)/Shell.tsx',
      'src/app/(app)/(management)/system/page.tsx',
    ]) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      expect(source, `${file} decides a landing page for itself`).toContain('homeFor(');
    }

    // And no hardcoded destination anybody could land on without permission.
    const shell = readFileSync(join(APP, 'Shell.tsx'), 'utf8');
    expect(shell).not.toContain('href="/dashboard"');
    const signIn = readFileSync(join(process.cwd(), 'src/app/sign-in/page.tsx'), 'utf8');
    expect(signIn).not.toContain("redirect('/clients')");
  });

  it('puts chat at the top of the sidebar, for everybody', () => {
    // Asked for in those words. It was eighteenth, behind sections most of the
    // team cannot use.
    const shell = readFileSync(join(APP, 'Shell.tsx'), 'utf8');
    const nav = shell.slice(shell.indexOf('const NAV'), shell.indexOf('const GROUPS'));
    const order = [...nav.matchAll(/href: '(\/[a-z-]+)'/g)].map((m) => m[1]!);
    expect(order[0], `the first nav item is ${order[0]}, not /chat`).toBe('/chat');
    // And it must not be gated: chat is everybody's.
    const chatLine = nav.slice(nav.indexOf("href: '/chat'"));
    expect(chatLine.slice(0, chatLine.indexOf('\n'))).not.toContain('minRole');
  });

  it('gates every commercial nav entry as well as its folder', () => {
    // Belt and braces, and it is the belt that a member sees: an ungated entry
    // would render a link that redirects, which reads as the app being broken.
    const shell = readFileSync(join(APP, 'Shell.tsx'), 'utf8');
    const nav = shell.slice(shell.indexOf('const NAV'), shell.indexOf('const GROUPS'));

    const ungated = COMMERCIAL.filter((name) => {
      const at = nav.indexOf(`href: '/${name}'`);
      if (at === -1) return false; // Not in the nav at all is fine.
      const line = nav.slice(at, nav.indexOf('\n', at));
      return !line.includes('minRole');
    });

    expect(
      ungated,
      `\nThese are linked in the sidebar with no minRole:\n  ${ungated.join(', ')}\n`,
    ).toEqual([]);
  });
});
