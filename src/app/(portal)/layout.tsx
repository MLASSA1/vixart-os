import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './portal.css';

/**
 * What a client sees in the tab.
 *
 * The root metadata says "VIXART OS", which is the name of the internal
 * system — correct for the team, and not a name a client has any reason to
 * read. The icon is shared: it is the same company either way.
 */
export const metadata: Metadata = {
  title: 'VIXART',
  description: 'Your projects, their progress, and a line to the team.',
  // A portal for named clients is not a page for a search engine. The nginx
  // header says so too; this says it to crawlers that read the document.
  robots: { index: false, follow: false },
};

/**
 * The portal's own shell.
 *
 * Nothing is shared with the internal application's layout: no sidebar, no
 * navigation into the business, no counts. What a client sees is written from
 * scratch, so a link added to the staff shell can never appear on a client's
 * screen by inheritance.
 *
 * The `.portal` class is what scopes the whole visual language — see
 * portal.css. Every rule in that file is a descendant of it, so the internal
 * application's warm paper and violet are untouched by any of this.
 */
export default function PortalRootLayout({ children }: { children: ReactNode }) {
  return <div className="portal">{children}</div>;
}
