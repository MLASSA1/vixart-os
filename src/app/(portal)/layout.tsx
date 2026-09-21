import type { ReactNode } from 'react';
import './portal.css';

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
