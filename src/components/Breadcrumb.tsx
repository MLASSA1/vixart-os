'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { whereAmI } from '@/lib/nav';

/**
 * "You are here", above every page title.
 *
 * Each page used to choose its own line for this spot, and over time they
 * chose twenty different ones — "Amin", "VIXART OS", "Before the camera",
 * "Archive", "Management only" — none of which said where in the application
 * you were. It is derived now, from the same map the sidebar draws
 * (src/lib/nav.ts), so it cannot drift from it:
 *
 *   a list page in a group      TEAM SPACE
 *   something inside a list     RELATIONSHIPS › Directory   (a link back)
 *   a top-level page            nothing — the title already says it
 */
export function Breadcrumb() {
  const pathname = usePathname();
  const here = whereAmI(pathname);
  if (!here || (!here.group && !here.inside)) return null;

  return (
    <nav aria-label="You are here" className="eyebrow flex flex-wrap items-center gap-x-1.5">
      {here.group && <span>{here.group}</span>}
      {here.inside && (
        <>
          {here.group && <span aria-hidden="true">›</span>}
          <Link
            href={here.item.href}
            className="normal-case tracking-normal underline-offset-4 hover:underline"
          >
            {here.item.label}
          </Link>
        </>
      )}
    </nav>
  );
}
